/**
 * Comment anchoring — how a review note stays attached to a place in a document that is being edited.
 *
 * A comment is anchored by a {@link TreePath}, like everything else in the editing layer, so it shares
 * the paths' one weakness: a path is only meaningful against one tree state. The anchor is therefore
 * stored as `originalPath` plus `anchoredAfterOp` (how far the op log had run when it was written) and
 * the CURRENT anchor is DERIVED — replayed forward through `transformPath` for each op between the
 * anchoring point and the cursor. Two consequences, both deliberate (ADR-0014):
 *
 * - Undo/redo need no comment bookkeeping at all: move the cursor and the anchors follow, so a comment
 *   orphaned by a removal comes back, at its old path, when that removal is undone.
 * - Below its anchoring point a comment can only be shown where it was authored (`transformPath` has no
 *   inverse). The `quote` captured at anchoring time is what catches such a drifted note:
 *   {@link isCommentStale} compares it with the text now at the anchor.
 *
 * The functions here are pure and document-model-only — the editing session owns the comment list, and
 * the review Renderer only reads.
 */

import type { DocumentNode, DocumentTree } from "../document-tree";
import { LegalDocsError } from "../errors";
import { richTextToMarkdown } from "../rich-text";
import type { Comment, EditOp } from "./edit-set";
import { locate } from "./locate";
import { EditError, transformPath, type TreePath } from "./tree-path";

/** What derivation needs of a comment: where it was written, and after how many ops. */
export type CommentAnchor = Pick<Comment, "originalPath" | "anchoredAfterOp">;

/**
 * Where `anchor` sits once `ops[anchor.anchoredAfterOp … cursor)` have been applied, or `null` when one
 * of those ops removed it (the comment is then orphaned). A cursor at or before the anchoring point
 * yields `originalPath` unchanged.
 */
export function deriveCommentPath(anchor: CommentAnchor, ops: readonly EditOp[], cursor: number): TreePath | null {
  let path: TreePath | null = anchor.originalPath;
  for (let index = anchor.anchoredAfterOp; index < cursor; index += 1) {
    const op = ops[index];
    if (op === undefined) break;
    path = transformPath(path, op);
    if (path === null) return null;
  }
  return path;
}

/**
 * The text now at `path`, as a comment quotes it — `undefined` when the path addresses nothing
 * quotable (it no longer resolves, or it points at a container or a `custom` block).
 */
export function quoteAt(tree: DocumentTree, path: TreePath): string | undefined {
  try {
    const location = locate(tree, path);
    switch (location.kind) {
      case "text":
        return location.value;
      case "node":
        return nodeText(location.node);
      case "richText":
        return richTextToMarkdown(location.node.value);
      default:
        return undefined;
    }
  } catch (error) {
    if (error instanceof EditError) return undefined;
    throw error;
  }
}

/**
 * A node's text, flattened for quoting. Not a Renderer: this is the one-line gist a reviewer recognises
 * in the margin, which is also why a `custom` block has none (its content is code-side, ADR-0005).
 */
export function nodeText(node: DocumentNode): string | undefined {
  switch (node.kind) {
    case "title":
    case "paragraph":
      return node.text;
    case "richText":
      return richTextToMarkdown(node.value);
    case "article":
      return node.heading === undefined ? node.no : `${node.no} ${node.heading}`;
    case "numberedList":
    case "bulletList":
    case "alphaList":
      return joinText(node.items.flat());
    case "partyHeader":
      return `${node.roleLabel}: ${node.party.name}`;
    case "keyValueTable":
      return node.rows.map((row) => `${row.label}: ${row.value}`).join("; ");
    case "signatures":
      return node.places.map((place) => place.name).join(", ");
    case "custom":
      return undefined;
    default: {
      const unhandled: never = node;
      throw new LegalDocsError(`Unsupported node kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

function joinText(nodes: DocumentNode[]): string {
  return nodes
    .map(nodeText)
    .filter((text): text is string => text !== undefined)
    .join(" ");
}

/**
 * The comment still points at a node, but that node no longer reads as it did when the comment was
 * written — the review view flags it so a reviewer does not answer a sentence that has already changed.
 * A comment without a quote (or an orphaned one) is never stale: there is nothing to compare.
 */
export function isCommentStale(tree: DocumentTree, comment: Comment): boolean {
  if (comment.path === null || comment.quote === undefined) return false;
  return quoteAt(tree, comment.path) !== comment.quote;
}
