import type { Node as PmNode, ResolvedPos } from "prosemirror-model";
import { lcsAlign, normalizeTree, pairAligned } from "@petrpus/legal-docs/edit";
import type {
  DocumentNode,
  DocumentTree,
  EditableNode,
  EditError,
  EditOp,
  EditSession,
  TreePath,
} from "@petrpus/legal-docs/edit";
import { pmDocToTree } from "./pm-schema";

/**
 * The WYSIWYG editor's half of the contract (#159): turn *the document the editor now holds* into the
 * **Edit ops** that take the session's tree there.
 *
 * ProseMirror reports a change as a transaction over positions; the Edit set speaks tree paths and typed
 * ops (ADR-0014). Rather than translate step by step — which would need node identity the tree does not
 * carry — this maps the two documents against each other with the library's own `lcsAlign`, the same
 * alignment the redline is built from. One alignment per node list, walked once, emitting ops whose paths
 * are valid **at the moment each op is applied**: that is why the walk carries a live index `i` that a
 * removal leaves alone and an insertion advances.
 *
 * A reorder therefore reads as a removal and an insertion, never as `moveNode`: two positional documents
 * cannot tell "this block moved" from "it was deleted here and retyped there", and inventing the
 * distinction would put a lie in the audit trail. `moveNode` stays what the editor's explicit
 * Move up/down commands emit, where the human said which block moved.
 *
 * Pure and DOM-free, so the mapping is proved headlessly in `doc-ops.test.ts`.
 */

/** A change the op model cannot express — the editor re-projects from the session instead. */
export class DocSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocSyncError";
  }
}

/** What one editor→session sync did: the ops that went through, and what stopped the rest. */
export interface DocSyncResult {
  /** The ops applied to the session, in order. Empty when nothing changed or nothing could be applied. */
  ops: EditOp[];
  /** The rejected op's `EditError`, or a {@link DocSyncError} for a change no op can express. */
  error?: EditError | DocSyncError;
}

/**
 * Push the editor's document into the session. The tree is compared in its **normal form** (the shape a
 * ProseMirror document can hold — see `normalizeTree` and E8), which the paths are indifferent to:
 * normalizing rewrites rich-text runs, never the structure the ops address.
 */
export function syncSessionToDoc(session: EditSession, doc: PmNode): DocSyncResult {
  let pending: EditOp[];
  try {
    pending = opsBetween(normalizeTree(session.tree), pmDocToTree(doc));
  } catch (error) {
    if (error instanceof DocSyncError) return { ops: [], error };
    throw error;
  }
  const ops: EditOp[] = [];
  for (const op of pending) {
    const result = session.apply(op);
    // A rejected op is an ordinary answer: the ops before it stand, the editor re-projects from the tree.
    if (!result.ok) return { ops, error: result.error };
    ops.push(op);
  }
  return { ops };
}

/**
 * Whether the editor is already showing exactly the session's document.
 *
 * Compared as *trees*, not as ProseMirror nodes: the editor's schema is TipTap's instance of the mapped
 * schema, so `Node.eq` — which compares node types by identity — would call every document different.
 */
export function isSyncedWith(session: EditSession, doc: PmNode): boolean {
  try {
    return opsBetween(normalizeTree(session.tree), pmDocToTree(doc)).length === 0;
  } catch {
    // A document the op model cannot express is, by definition, not the session's.
    return false;
  }
}

/** The ops that turn `before` into `after`, to be applied in order. Neither tree is mutated. */
export function opsBetween(before: DocumentTree, after: DocumentTree): EditOp[] {
  const ops: EditOp[] = [];
  // Page furniture and page setup are not part of the editable document — the editor parks them on the
  // doc's attrs and hands them back verbatim, so they can only ever compare equal here.
  diffNodes(["body"], before.body, after.body, ops);
  return ops;
}

/**
 * Align two sibling lists and emit the ops that reconcile them. `i` is the index the next unprocessed
 * element holds in the list *as the ops so far have left it* — a removal takes an element out (so `i`
 * stays put), everything else advances past one element.
 */
function diffNodes(parent: TreePath, before: readonly DocumentNode[], after: readonly DocumentNode[], ops: EditOp[]): void {
  let i = 0;
  for (const step of pairAligned(lcsAlign(before, after, sameValue))) {
    const path = [...parent, i];
    switch (step.op) {
      case "equal":
        i++;
        break;
      case "replaced":
        if (!reconcile(path, step.before, step.after, ops)) {
          ops.push({ op: "removeNode", path });
          ops.push({ op: "insertNode", path, node: insertable(step.after) });
        }
        i++;
        break;
      case "removed":
        ops.push({ op: "removeNode", path });
        break;
      case "added":
        ops.push({ op: "insertNode", path, node: insertable(step.after) });
        i++;
        break;
    }
  }
}

/** The same walk over a list's items. There is no "move item" op, so a reorder is a remove and an insert. */
function diffItems(itemsPath: TreePath, before: readonly DocumentNode[][], after: readonly DocumentNode[][], ops: EditOp[]): void {
  let i = 0;
  for (const step of pairAligned(lcsAlign(before, after, sameValue))) {
    const path = [...itemsPath, i];
    switch (step.op) {
      case "equal":
        i++;
        break;
      case "replaced":
        // A paired item is the *same* item reworded — its blocks are a node list like any other.
        diffNodes(path, step.before, step.after, ops);
        i++;
        break;
      case "removed":
        ops.push({ op: "removeListItem", path });
        break;
      case "added":
        ops.push({ op: "insertListItem", path, item: step.after.map(insertable) });
        i++;
        break;
    }
  }
}

/**
 * Express "the node at `path` became `after`" as ops that edit it in place. `false` means it cannot be
 * edited into the new node and the caller should remove and insert instead.
 */
function reconcile(path: TreePath, before: DocumentNode, after: DocumentNode, ops: EditOp[]): boolean {
  if (sameValue(before, after)) return true;
  // A custom block is opaque (ADR-0005): it can be removed or inserted, never edited or replaced.
  if (before.kind === "custom" || after.kind === "custom") return false;
  if (before.kind !== after.kind) {
    ops.push({ op: "replaceNode", path, node: after });
    return true;
  }
  switch (before.kind) {
    case "title":
    case "paragraph": {
      const next = asKind(after, before.kind);
      if (before.text !== next.text) ops.push({ op: "setText", path: [...path, "text"], value: next.text });
      if (before.align !== next.align) ops.push({ op: "setStyle", path: [...path, "align"], value: next.align ?? null });
      if (!sameValue(before.indent, next.indent)) {
        ops.push({ op: "setStyle", path: [...path, "indent"], value: next.indent ?? null });
      }
      return true;
    }
    case "richText":
      ops.push({ op: "setRichText", path: [...path, "value"], value: asKind(after, "richText").value });
      return true;
    case "article": {
      const next = asKind(after, "article");
      // `no` and `level` are not editable (ADR-0014): the number is assigned during assembly and the
      // level is derived from nesting depth on the way out of the editor, never typed.
      if (before.heading !== next.heading) {
        ops.push({ op: "setText", path: [...path, "heading"], value: next.heading ?? null });
      }
      diffNodes([...path, "body"], before.body, next.body, ops);
      return true;
    }
    case "numberedList":
    case "bulletList":
    case "alphaList":
      diffItems([...path, "items"], before.items, asKind(after, before.kind).items, ops);
      return true;
    case "partyHeader":
    case "keyValueTable":
    case "signatures":
      // The atoms are edited through a node-view form, which changes a whole attribute at once; one
      // `replaceNode` is both the smallest honest op and what the redline reads as an attribute change.
      ops.push({ op: "replaceNode", path, node: after });
      return true;
  }
}

/**
 * The tree path of the block a caret (or a selected atom) sits in — the editor's answer to "which node
 * am I editing", for the block toolbar and for keeping the form editor's selection on the caret.
 *
 * An article's heading is a *field* of the article, not a block of its own, so a caret in it addresses
 * the article. `undefined` means the position addresses nothing editable.
 */
export function treePathAt(from: ResolvedPos): TreePath | undefined {
  let path: (string | number)[] = [];
  for (let depth = 0; depth <= from.depth; depth++) {
    const parent = from.node(depth);
    const index = from.index(depth);
    switch (parent.type.name) {
      case "doc":
        path = ["body", index];
        break;
      case "article": {
        const headed = parent.firstChild?.type.name === "articleHeading";
        if (headed && index === 0) return path.length > 0 ? path : undefined;
        path = [...path, "body", headed ? index - 1 : index];
        break;
      }
      case "list":
        path = [...path, "items", index];
        break;
      case "listItem":
        path = [...path, index];
        break;
      default:
        // A text block (or a rich-text paragraph): the block itself is the addressable node.
        return path.length > 0 ? path : undefined;
    }
  }
  return path.length > 0 ? path : undefined;
}

/** A node about to be inserted. `custom` is the one kind no op can introduce — say so, do not guess. */
function insertable(node: DocumentNode): EditableNode {
  if (node.kind === "custom") {
    throw new DocSyncError(`a custom block (${node.component}) cannot be inserted by an edit`);
  }
  return node;
}

/** The paired node, re-typed: `reconcile` reaches a case only when both nodes carry that same kind. */
function asKind<K extends DocumentNode["kind"]>(node: DocumentNode, _kind: K): Extract<DocumentNode, { kind: K }> {
  return node as Extract<DocumentNode, { kind: K }>;
}

/**
 * Structural equality — what "unchanged" means to the alignment. A key whose value is `undefined` counts
 * as absent, so a `custom` block's `props: undefined` survives a JSON round trip without reading as a
 * change (the same rule the library's redline model uses).
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
}
