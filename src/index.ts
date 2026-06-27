export { Catalog } from "./catalog/catalog";
export { FileCatalogStore } from "./catalog/file-catalog-store";
export type { CatalogStore } from "./catalog/catalog-store";

export { renderDocument } from "./facade/render-document";
export type { RenderDocumentInput, RenderDocumentResult } from "./facade/render-document";

export { assembleTree } from "./core/engine";
export type { Template, BodyItem } from "./core/template";
export type { DocumentNode, DocumentTree, InlineRich } from "./core/document-tree";

export { defaultTheme } from "./render-pdf/theme";
export type { Theme } from "./render-pdf/theme";
