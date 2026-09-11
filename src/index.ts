export { Catalog } from "./catalog/catalog";
export type { ClauseDiffOptions } from "./catalog/catalog";
export { FileCatalogStore } from "./catalog/file-catalog-store";
export { MemoryCatalogStore } from "./catalog/memory-catalog-store";
export type { MemoryCatalogSeed, MemoryFamily } from "./catalog/memory-catalog-store";
export { MemoryEditableCatalogStore } from "./catalog/memory-editable-catalog-store";
export type { MemoryEditableOptions } from "./catalog/memory-editable-catalog-store";
export { diffRichText } from "./core/clause-diff";
export type { ClauseDiff, ClauseDiffChange } from "./core/clause-diff";
export type { CatalogStore } from "./catalog/catalog-store";
export { isEditableStore } from "./catalog/editable-catalog-store";
export type {
  EditableCatalogStore,
  Actor,
  ElementStatus,
  ElementRef,
  ElementContent,
  DraftRef,
  DraftHandle,
  PublishResult,
} from "./catalog/editable-catalog-store";
export type { AuditEntry, AuditAction } from "./catalog/audit";
export { LegalDocsError, NotFoundError } from "./core/errors";
export type { NotFoundKind, NotFoundRef } from "./core/errors";
export { PublishValidationError } from "./catalog/editing-facade";
export type { EditingApi } from "./catalog/editing-facade";
export type {
  ValidationResult,
  ValidationFinding,
  ValidateOptions,
} from "./catalog/validate";

export { renderDocument } from "./facade/render-document";
export type {
  RenderDocumentInput,
  RenderDocumentResult,
  PdfRenderResult,
  HtmlRenderResult,
  DocxRenderResult,
} from "./facade/render-document";
export { renderFromSnapshot } from "./facade/render-from-snapshot";
export type {
  RenderFromSnapshotOptions,
  RenderFromSnapshotResult,
  PdfFromSnapshot,
  HtmlFromSnapshot,
  DocxFromSnapshot,
} from "./facade/render-from-snapshot";
export { renderEdited } from "./facade/render-edited";
export type {
  RenderEditedInput,
  RenderEditedResult,
  PdfEditedResult,
  HtmlEditedResult,
  DocxEditedResult,
} from "./facade/render-edited";
export { buildSnapshot, DEFAULT_SNAPSHOT_MODE, SNAPSHOT_SCHEMA_VERSION, SnapshotError, assertValidSnapshot } from "./core/snapshot";
export type { Snapshot, SnapshotMode, ClausePin, SnapshotInput } from "./core/snapshot";
export { buildEditedSnapshot, verifyEditedSnapshot } from "./core/edited-snapshot";
export type { EditedSnapshot, EditedSnapshotIssue, EditedSnapshotVerification } from "./core/edited-snapshot";

export { assembleTree, assembleDocument } from "./core/engine";
export type { AssembleContext, ClauseResolver } from "./core/engine";
export type {
  Template,
  Include,
  BaseTemplate,
  Variant,
  BodyItem,
  ArticleItem,
  KeyValueRows,
  SignaturePlaceSpec,
  PageFurnitureSpec,
} from "./core/template";
export { expandIncludes, IncludeError } from "./core/includes";
export type { IncludeLoader } from "./core/includes";
export { composeTemplate, CompositionError } from "./core/compose";
export {
  asDocumentTree,
  DOCUMENT_NODE_KINDS,
  isDocumentNodeKind,
  PAGE_NUMBER_SENTINEL,
  PAGE_TOTAL_SENTINEL,
} from "./core/document-tree";
export type {
  DocumentNode,
  DocumentNodeKind,
  DocumentTree,
  DocumentBody,
  PageFurniture,
  InlineRich,
  PartyIdentification,
  KeyValueRow,
  SignaturePlace,
} from "./core/document-tree";
export {
  assertValidTree,
  documentNodeKinds,
  documentNodeSchema,
  documentTreeSchema,
  richTextV1Schema,
  TreeValidationError,
  DOCUMENT_NODE_LIST_SCHEMA_ID,
} from "./core/document-tree-schema";
export type { TreeIssue } from "./core/document-tree-schema";

// The editing layer (PRD #147 / ADR-0014): tree paths, the Edit set model and the pure apply function.
// Everything here is browser-safe and is also reachable from the browser entry.
export {
  applyEdit,
  applyEdits,
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
} from "./core/edit";
export type {
  Comment,
  EditableNode,
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
} from "./core/edit";

export type { Clause } from "./core/clause";
export { parseClauseRef } from "./core/clause-ref";
export type { ClauseRef } from "./core/clause-ref";
export { MARK_VALUES, parseRichText } from "./core/rich-text";
export type { RichTextV1, RichParagraph, RichRun, Mark } from "./core/rich-text";
export { validateVars, VarsValidationError } from "./core/vars-schema";
export type { VarsSchema, VarSpec, VarType } from "./core/vars-schema";

export { evaluate, ExpressionError } from "./core/expression";
export type { EvalContext, Scope } from "./core/expression";
export { interpolate } from "./core/interpolate";

export { validatePayload, PayloadValidationError } from "./core/payload";
export type { PayloadSchemaRegistry, PayloadIssue } from "./core/payload";
export { resolvePayload } from "./core/resolve";
export type { Derivation, DerivationRegistry, ResolvedPayload } from "./core/resolve";
export { money, loan, party } from "./core/schema-fragments";
export type { Money, Loan, Party } from "./core/schema-fragments";
export { exportDocumentTreeSchema, exportEditSetSchema, exportPayloadSchema, exportPayloadSchemas } from "./core/json-schema";
export type { JsonSchema, JsonSchemaTarget, JsonSchemaOptions } from "./core/json-schema";
export { defaultHelpers, makeDefaultHelpers } from "./core/helpers";
export type { Helper, HelperRegistry } from "./core/helpers";

export { defaultTheme, mergeTheme, DEFAULT_FONT_FAMILY } from "./theme";
export type { Theme, DeepPartial } from "./theme";
export { PAGE_SIZES, effectivePage, isPageSizeName } from "./core/page";
export type { PageSizeName, PageOrientation, PageSetup } from "./core/page";
// Re-export react-pdf's Font so consumers can register their own PDF fonts (e.g. a branded family), plus
// the bundled diacritics-safe default registration. See docs/THEMING.md.
export { Font } from "@react-pdf/renderer";
export { clearGlyphCaches, registerBundledFonts } from "./render-pdf/fonts";
export type {
  CustomBlock,
  CustomBlockRegistry,
  CustomBlockContext,
  PdfCustomBlock,
  HtmlCustomBlock,
  DocxCustomBlock,
  DegradationMode,
  DegradationEvent,
  OnDegrade,
} from "./custom-block";
export type { RenderTreeOptions } from "./custom-block";
export { renderTreeToPdf } from "./render-pdf/render-pdf";
export { createHtmlRenderContext, renderNodeToHtml, renderTreeToHtml } from "./render-html/render-html";
export type { HtmlRenderContext, RenderHtmlOptions } from "./render-html/render-html";
export { escapeHtml } from "./render-html/escape";
export { renderClauseDiff } from "./render-html/clause-diff-html";
export { renderTreeToDocx } from "./render-docx/render-docx";
export { halfPoints, twips, eighths } from "./render-docx/theme-docx";
export { deepBind } from "./core/deep-bind";
