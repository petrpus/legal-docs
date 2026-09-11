/**
 * The editing layer's core: tree paths, the Edit set model and the pure `applyEdits` function.
 *
 * Everything reachable from this entry is browser-safe by construction (no `node:` built-in, no
 * dependency but zod) — `tests/edit-browser-safety.test.ts` scans the module graph to keep it that
 * way, because a client applies ops and previews HTML while only identity and the PDF/DOCX renderers
 * stay on the server (ADR-0012).
 */

export { applyEdit, applyEdits } from "./apply";
export {
  assertValidEditSet,
  commentSchema,
  editableNodeSchema,
  editOpPath,
  editOpSchema,
  editSetSchema,
  EditSetValidationError,
  EDIT_OP_KINDS,
  EDIT_SET_SCHEMA_VERSION,
  treePathSchema,
} from "./edit-set";
export type { Comment, EditableNode, EditOp, EditOpKind, EditSet } from "./edit-set";
export { locate } from "./locate";
export type { TextLocation, TreeLocation } from "./locate";
export { EditError, editError, formatTreePath, parseTreePath, transformPath } from "./tree-path";
export type { EditErrorInit, EditErrorReason, TreePath, TreePathSegment } from "./tree-path";
