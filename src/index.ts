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
export { buildSnapshot, DEFAULT_SNAPSHOT_MODE, SNAPSHOT_SCHEMA_VERSION, SnapshotError, assertValidSnapshot } from "./core/snapshot";
export type { Snapshot, SnapshotMode, ClausePin, SnapshotInput } from "./core/snapshot";

export { assembleTree } from "./core/engine";
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
} from "./core/template";
export { expandIncludes, IncludeError } from "./core/includes";
export type { IncludeLoader } from "./core/includes";
export { composeTemplate, CompositionError } from "./core/compose";
export type {
  DocumentNode,
  DocumentTree,
  InlineRich,
  PartyIdentification,
  KeyValueRow,
  SignaturePlace,
} from "./core/document-tree";

export type { Clause } from "./core/clause";
export { parseClauseRef } from "./core/clause-ref";
export type { ClauseRef } from "./core/clause-ref";
export { parseRichText } from "./core/rich-text";
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
export { defaultHelpers } from "./core/helpers";
export type { Helper, HelperRegistry } from "./core/helpers";

export { defaultTheme, DEFAULT_FONT_FAMILY } from "./render-pdf/theme";
export type { Theme } from "./render-pdf/theme";
// Re-export react-pdf's Font so consumers can register their own PDF fonts (e.g. a branded family), plus
// the bundled diacritics-safe default registration. See docs/THEMING.md.
export { Font } from "@react-pdf/renderer";
export { registerBundledFonts } from "./render-pdf/fonts";
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
} from "./render-pdf/custom-block";
export { renderTreeToHtml } from "./render-html/render-html";
export { escapeHtml } from "./render-html/escape";
export { renderClauseDiff } from "./render-html/clause-diff-html";
export { renderTreeToDocx } from "./render-docx/render-docx";
export { halfPoints, twips, eighths } from "./render-docx/theme-docx";
export { deepBind } from "./core/deep-bind";
