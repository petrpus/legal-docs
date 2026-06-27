export { Catalog } from "./catalog/catalog";
export { FileCatalogStore } from "./catalog/file-catalog-store";
export type { CatalogStore } from "./catalog/catalog-store";

export { renderDocument } from "./facade/render-document";
export type { RenderDocumentInput, RenderDocumentResult } from "./facade/render-document";

export { assembleTree } from "./core/engine";
export type { AssembleContext, ClauseResolver } from "./core/engine";
export type { Template, BodyItem, ArticleItem } from "./core/template";
export type { DocumentNode, DocumentTree, InlineRich } from "./core/document-tree";

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
export { money, loan } from "./core/schema-fragments";
export type { Money, Loan } from "./core/schema-fragments";
export { defaultHelpers } from "./core/helpers";
export type { Helper, HelperRegistry } from "./core/helpers";

export { defaultTheme } from "./render-pdf/theme";
export type { Theme } from "./render-pdf/theme";
