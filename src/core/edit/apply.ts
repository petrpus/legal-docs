/**
 * Applying an Edit set to a DocumentTree.
 *
 * The contract every other part of the editing layer leans on:
 * - **pure** — validate the input tree → deep copy → apply on the copy → validate the result. The
 *   caller's tree is never touched, so a rejected op leaves it exactly as it was (no partial edits).
 * - **sequential** — each op resolves against the tree as the previous op left it.
 * - **no `undefined` keys** — deleting an optional leaf removes the key, so an edit that restores the
 *   original yields a deep-equal tree and therefore the same Snapshot id.
 * - **browser-safe** — `structuredClone` and zod only; nothing here reaches for a Node built-in.
 *
 * C2 implements `setText`; the remaining ops are rejected by name (`not-implemented`) until C4, so a
 * caller never mistakes a silently ignored op for an applied one.
 */

import type { DocumentTree } from "../document-tree";
import { assertValidTree, describeIssues } from "../document-tree-schema";
import { editOpPath, editOpSchema, type EditOp } from "./edit-set";
import { locate, type TreeLocation } from "./locate";
import { EditError, editError, type TreePath } from "./tree-path";

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
    switch (op.op) {
      case "setText":
        setText(draft, op);
        return;
      default:
        throw editError("not-implemented", reportedPath(op), `the ${op.op} op is not implemented yet`);
    }
  } catch (error) {
    // Path-level helpers know nothing about Edit sets; stamp the op context on the way out.
    if (error instanceof EditError && error.opIndex === undefined) throw error.withOp(op.op, index);
    throw error;
  }
}

function setText(draft: DocumentTree, op: Extract<EditOp, { op: "setText" }>): void {
  const location = locate(draft, op.path);
  if (location.kind !== "text") {
    throw editError("wrong-target", op.path, `setText needs a text leaf, but this path addresses ${describeLocation(location)}`);
  }
  if (op.value === null) {
    if (location.required) throw editError("invalid-value", op.path, `"${location.key}" is required and cannot be deleted`);
    delete location.container[location.key];
    return;
  }
  location.container[location.key] = op.value;
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
