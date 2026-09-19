/**
 * Applying an Edit set to a DocumentTree.
 *
 * The contract every other part of the editing layer leans on:
 * - **pure** — validate the input tree → deep copy → apply on the copy → validate the result. The
 *   caller's tree is never touched, so a rejected op leaves it exactly as it was (no partial edits).
 *   Values the ops carry are copied in, too, so the result never aliases the caller's op objects.
 * - **sequential** — each op resolves against the tree as the previous op left it.
 * - **no `undefined` keys** — deleting an optional leaf removes the key, so an edit that restores the
 *   original yields a deep-equal tree and therefore the same Snapshot id.
 * - **browser-safe** — `structuredClone` and zod only; nothing here reaches for a Node built-in.
 *
 * Every op resolves its target through `locate`, the single definition of the editable surface, so no
 * op can quietly widen what a human may change. Structural ops that address a POSITION rather than an
 * element (an insert at the end of a list) resolve the parent list through `locate` and check the
 * trailing index here — see {@link positionIn}.
 */

import type { BlockIndent, DocumentNode, DocumentTree } from "../document-tree";
import { assertValidTree, describeIssues } from "../document-tree-schema";
import { editOpPath, editOpSchema, type EditOp, type EditOpKind } from "./edit-set";
import { CUSTOM_IS_OPAQUE, locate, type TreeLocation } from "./locate";
import { EditError, editError, formatTreePath, type TreePath } from "./tree-path";

/** Apply one op. Equivalent to `applyEdits(tree, [op])`. */
export function applyEdit(tree: DocumentTree, op: EditOp): DocumentTree {
  return applyEdits(tree, [op]);
}

/**
 * Apply a sequence of ops to a tree, returning a new tree. Throws an {@link EditError} carrying the op
 * index, the op kind and the path for the first op that cannot be applied, and a `TreeValidationError`
 * when the input (or, defensively, the result) is not a valid tree.
 */
export function applyEdits(tree: DocumentTree, ops: readonly EditOp[]): DocumentTree {
  assertValidTree(tree);
  const draft = structuredClone(tree);
  ops.forEach((op, index) => applyToDraft(draft, op, index));
  assertValidTree(draft);
  return draft;
}

function applyToDraft(draft: DocumentTree, op: EditOp, index: number): void {
  const parsed = editOpSchema.safeParse(op);
  if (!parsed.success) {
    throw new EditError({
      reason: "invalid-value",
      path: reportedPath(op),
      detail: describeIssues(parsed.error.issues),
      op: op.op,
      opIndex: index,
    });
  }
  try {
    applyOne(draft, op);
  } catch (error) {
    // Path-level helpers know nothing about Edit sets; stamp the op context on the way out.
    if (error instanceof EditError && error.opIndex === undefined) throw error.withOp(op.op, index);
    throw error;
  }
}

function applyOne(draft: DocumentTree, op: EditOp): void {
  switch (op.op) {
    case "setText":
      return setText(draft, op);
    case "setRichText":
      return setRichText(draft, op);
    case "setStyle":
      return setStyle(draft, op);
    case "replaceNode":
      return replaceNode(draft, op);
    case "insertNode":
      return insertNode(draft, op);
    case "removeNode":
      return removeNode(draft, op);
    case "moveNode":
      return moveNode(draft, op);
    case "insertListItem":
      return insertListItem(draft, op);
    case "removeListItem":
      return removeListItem(draft, op);
    case "setFurniture":
      return setFurniture(draft, op);
  }
  const unhandled: never = op;
  throw editError("invalid-value", [], `unknown edit op ${JSON.stringify(unhandled)}`);
}

type Op<K extends EditOpKind> = Extract<EditOp, { op: K }>;

function setText(draft: DocumentTree, op: Op<"setText">): void {
  const location = locate(draft, op.path);
  if (location.kind !== "text") throw wrongTarget("setText", op.path, location, "a text leaf");
  if (op.value === null) {
    if (location.required) throw editError("invalid-value", op.path, `"${location.key}" is required and cannot be deleted`);
    delete location.container[location.key];
    return;
  }
  location.container[location.key] = op.value;
}

function setRichText(draft: DocumentTree, op: Op<"setRichText">): void {
  const location = locate(draft, op.path);
  if (location.kind !== "richText") throw wrongTarget("setRichText", op.path, location, "a richText node's value");
  location.node.value = structuredClone(op.value);
}

function setStyle(draft: DocumentTree, op: Op<"setStyle">): void {
  const location = locate(draft, op.path);
  if (location.kind !== "style") throw wrongTarget("setStyle", op.path, location, "an align or indent override");
  // The op's value type is the UNION of both overrides, so the key decides which half fits here.
  if (location.key === "align") {
    if (op.value === null) delete location.node.align;
    else if (typeof op.value === "string") location.node.align = op.value;
    else throw editError("invalid-value", op.path, `"align" takes an alignment, not an indent object`);
    return;
  }
  if (op.value === null) delete location.node.indent;
  // A partial indent REPLACES the whole object — an absent side means "inherit the Theme default"
  // (ADR-0008), so merging into the old value would make that impossible to express. An indent with
  // no set side is no indent at all: it is stored as an absent key, never as `{}`, so two Edit sets
  // that mean the same thing produce the same tree (and the same Snapshot id).
  else if (typeof op.value === "object") {
    const indent: BlockIndent = {};
    if (op.value.firstLine !== undefined) indent.firstLine = op.value.firstLine;
    if (op.value.left !== undefined) indent.left = op.value.left;
    if (indent.firstLine === undefined && indent.left === undefined) delete location.node.indent;
    else location.node.indent = indent;
  } else throw editError("invalid-value", op.path, `"indent" takes an indent object, not the alignment ${JSON.stringify(op.value)}`);
}

function replaceNode(draft: DocumentTree, op: Op<"replaceNode">): void {
  const location = nodeAt(draft, op.path, "replaceNode");
  // The replacement is guarded by `editableNodeSchema`; the TARGET needs its own check, because a
  // `custom` block is reachable as a node (it can be removed or moved) but never rewritten.
  if (location.node.kind === "custom") throw editError("not-editable", op.path, CUSTOM_IS_OPAQUE);
  location.list[location.index] = structuredClone(op.node);
}

function insertNode(draft: DocumentTree, op: Op<"insertNode">): void {
  const { list, index } = nodePosition(draft, op.path, "insertNode");
  list.splice(index, 0, structuredClone(op.node));
}

function removeNode(draft: DocumentTree, op: Op<"removeNode">): void {
  const location = nodeAt(draft, op.path, "removeNode");
  location.list.splice(location.index, 1);
}

function moveNode(draft: DocumentTree, op: Op<"moveNode">): void {
  const source = nodeAt(draft, op.from, "moveNode");
  const node = source.list.splice(source.index, 1)[0]!;
  // `to` is read against the tree AFTER the removal (RFC 6902 `move`), which is also what makes a
  // destination inside the moved subtree fail: that subtree is no longer in the tree to address.
  const target = nodePosition(draft, op.to, "moveNode");
  target.list.splice(target.index, 0, node);
}

function insertListItem(draft: DocumentTree, op: Op<"insertListItem">): void {
  const { items, index } = itemPosition(draft, op.path, "insertListItem", "insert");
  items.splice(index, 0, structuredClone(op.item));
}

function removeListItem(draft: DocumentTree, op: Op<"removeListItem">): void {
  const { items, index } = itemPosition(draft, op.path, "removeListItem", "existing");
  items.splice(index, 1);
}

function setFurniture(draft: DocumentTree, op: Op<"setFurniture">): void {
  const location = locate(draft, op.path);
  if (location.kind !== "furniture") throw wrongTarget("setFurniture", op.path, location, "a whole header or footer");
  if (op.value === null) delete location.tree[location.slot];
  else location.tree[location.slot] = structuredClone(op.value);
}

/** The node a kind-agnostic structural op addresses. `locate` already reports an index out of range. */
function nodeAt(draft: DocumentTree, path: TreePath, op: EditOpKind): Extract<TreeLocation, { kind: "node" }> {
  const location = locate(draft, path);
  if (location.kind !== "node") throw wrongTarget(op, path, location, "a node");
  return location;
}

/** Whether a trailing index addresses an existing element or a slot to insert at (length allowed). */
type IndexUse = "existing" | "insert";

/**
 * An insert addresses a POSITION, not an element — `…/2` in a list of two appends — and `locate` only
 * answers about elements. So the parent list is resolved through `locate` and the trailing index is
 * checked here, which also keeps "the index is not an index" a path error rather than a lookup miss.
 */
function positionIn(draft: DocumentTree, path: TreePath, op: EditOpKind): { location: TreeLocation; index: number } {
  const index = path[path.length - 1];
  if (typeof index !== "number") {
    throw editError("invalid-path", path, `${op} needs a path ending in an index, but ${formatTreePath(path)} does not`);
  }
  return { location: locate(draft, path.slice(0, -1)), index };
}

function checkBound(path: TreePath, index: number, length: number, use: IndexUse): void {
  const bound = use === "insert" ? length : length - 1;
  if (index <= bound) return;
  const appends = use === "insert" ? " (an index equal to the length appends)" : "";
  throw editError("out-of-range", path, `index ${index} is outside a list of ${length}${appends}`);
}

function nodePosition(draft: DocumentTree, path: TreePath, op: EditOpKind): { list: DocumentNode[]; index: number } {
  const { location, index } = positionIn(draft, path, op);
  if (location.kind !== "nodeList") throw wrongPosition(op, path, location, "a node list");
  checkBound(path, index, location.list.length, "insert");
  return { list: location.list, index };
}

function itemPosition(
  draft: DocumentTree,
  path: TreePath,
  op: EditOpKind,
  use: IndexUse,
): { items: DocumentNode[][]; index: number } {
  const { location, index } = positionIn(draft, path, op);
  if (location.kind !== "listItems") throw wrongPosition(op, path, location, "a list's items");
  checkBound(path, index, location.items.length, use);
  return { items: location.items, index };
}

function wrongTarget(op: EditOpKind, path: TreePath, location: TreeLocation, needs: string): EditError {
  return editError("wrong-target", path, `${op} needs ${needs}, but this path addresses ${describeLocation(location)}`);
}

/** The same refusal for a position op, which names the PARENT it resolved rather than the op's path. */
function wrongPosition(op: EditOpKind, path: TreePath, location: TreeLocation, needs: string): EditError {
  const parent = formatTreePath(path.slice(0, -1));
  return editError("wrong-target", path, `${op} needs a position in ${needs}, but ${parent} is ${describeLocation(location)}`);
}

/** The path an error is reported against — defensive about an op that failed its schema. */
function reportedPath(op: EditOp): TreePath {
  const path = editOpPath(op);
  return Array.isArray(path) ? path : [];
}

function describeLocation(location: TreeLocation): string {
  switch (location.kind) {
    case "nodeList":
      return "a node list";
    case "node":
      return `a ${location.node.kind} node`;
    case "listItems":
      return "a list's items";
    case "richText":
      return "a rich-text value";
    case "style":
      return `a ${location.key} override`;
    case "furniture":
      return `the page ${location.slot}`;
    default:
      return "a text leaf";
  }
}
