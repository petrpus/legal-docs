/**
 * `@petrpus/legal-docs/edit` — the browser-safe editing subpath.
 *
 * Everything an editor UI needs to change an assembled document and show the result: the
 * {@link createEditSession} state machine, the Edit op / Edit set model, tree paths, the pure
 * `applyEdits`, the tree diff and redline model, and the HTML Renderer the preview goes through.
 * Deliberately NOT here: Snapshot identity (`buildEditedSnapshot` hashes with `node:crypto`) and the
 * PDF/DOCX exporters — those stay on the server behind the root entry (ADR-0012).
 *
 * The subpath is editor-agnostic by design (ADR-0014): no ProseMirror, no TipTap, no React. A WYSIWYG
 * shell binds to this session from the outside; `tests/edit-browser-safety.test.ts` enforces both rules
 * against the sources and against the built bundle.
 */

export { createEditSession, EditSessionError } from "./session";
export type { EditApplyResult, EditSession, EditSessionBase, EditSessionInit } from "./session";

export {
  applyEdit,
  applyEdits,
  assertValidEditOp,
  assertValidEditSet,
  buildRedline,
  commentSchema,
  diffTree,
  diffWords,
  editableNodeSchema,
  editOpPath,
  editOpSchema,
  editSetSchema,
  EditError,
  EditSetValidationError,
  EDIT_OP_KINDS,
  EDIT_SET_SCHEMA_VERSION,
  formatTreePath,
  locate,
  parseTreePath,
  transformPath,
  treePathSchema,
} from "../core/edit";
export type {
  Comment,
  EditableNode,
  EditErrorInit,
  EditErrorReason,
  EditOp,
  EditOpKind,
  EditSet,
  InlineOp,
  InlineSegment,
  RedlineAttr,
  RedlineBlock,
  RedlineChildren,
  RedlineDoc,
  RedlineField,
  RedlineListItem,
  RedlineParagraph,
  RedlineRun,
  RedlineStats,
  TextLocation,
  TreeChange,
  TreeLocation,
  TreePath,
  TreePathSegment,
} from "../core/edit";

// The document model the ops address, and the markdown subset a form editor offers for a `richText`
// node — `richTextToMarkdown` is `parseRichText`'s inverse.
export { MARK_VALUES, parseRichText, richTextToMarkdown } from "../core/rich-text";
export type { Mark, RichParagraph, RichRun, RichTextV1 } from "../core/rich-text";
export { assertValidTree, documentNodeKinds, TreeValidationError } from "../core/document-tree-schema";
export type {
  Align,
  BlockIndent,
  DocumentBody,
  DocumentNode,
  DocumentTree,
  KeyValueRow,
  PageFurniture,
  PartyIdentification,
  SignaturePlace,
} from "../core/document-tree";

// The preview Renderer, so a UI can render a tree (or a single node) without the root entry.
export { createHtmlRenderContext, renderNodeToHtml, renderTreeToHtml } from "../render-html/render-html";
export type { HtmlRenderContext, RenderHtmlOptions } from "../render-html/render-html";
