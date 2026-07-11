/**
 * Facade internals shared by `renderDocument` and `renderFromSnapshot`: the single format dispatch
 * over the tree Renderers, and the shared catalog→tree assembly pipeline that both the fresh render
 * and the `pins`-mode re-render (ADR-0003) run through.
 */

import { Readable } from "node:stream";
import { LegalDocsError } from "../core/errors";
import type { Catalog } from "../catalog/catalog";
import type { Template } from "../core/template";
import type { DocumentTree } from "../core/document-tree";
import { assembleDocument, type ClauseResolver } from "../core/engine";
import { expandIncludes } from "../core/includes";
import type { HelperRegistry } from "../core/helpers";
import type { RenderTreeOptions } from "../custom-block";
import { renderTreeToPdf } from "../render-pdf/render-pdf";
import { renderTreeToHtml } from "../render-html/render-html";
import { renderTreeToDocx } from "../render-docx/render-docx";

export type RenderFormat = "pdf" | "html" | "docx";

/** The format-discriminated rendered output (ADR-0006): binary formats carry `buffer`/`stream`. */
export type RenderedOutput =
  | { format: "pdf"; buffer: Buffer; stream: Readable }
  | { format: "html"; html: string }
  | { format: "docx"; buffer: Buffer; stream: Readable };

/**
 * Dispatch a DocumentTree to the Renderer for `format` and wrap the result in the discriminated
 * output shape. The one place a new format is added (the `never` check makes it a compile error
 * everywhere else).
 */
export async function renderTree(
  tree: DocumentTree,
  format: RenderFormat,
  options: RenderTreeOptions,
): Promise<RenderedOutput> {
  if (format === "html") {
    return { format: "html", html: renderTreeToHtml(tree, options) };
  }
  if (format === "pdf") {
    const buffer = await renderTreeToPdf(tree, options);
    return { format: "pdf", buffer, stream: Readable.from(buffer) };
  }
  if (format === "docx") {
    const buffer = await renderTreeToDocx(tree, options);
    return { format: "docx", buffer, stream: Readable.from(buffer) };
  }
  const unsupported: never = format;
  throw new LegalDocsError(`Unsupported format: ${String(unsupported)}`);
}

/** What tree assembly needs beyond the Template itself (the caller chooses scope and Clause policy). */
export interface AssembleFromCatalogContext {
  scope: Record<string, unknown>;
  helpers?: HelperRegistry;
  clauses: ClauseResolver;
  locale: string;
}

/**
 * The shared catalog→tree pipeline: expand Includes into a concrete body, then run tree assembly.
 * A fresh render and a `pins`-mode re-render differ only in what they pass here (live scope +
 * pin-recording resolver vs the Snapshot's frozen Resolved payload + pinned resolver), so the
 * "fresh render ≡ re-render from pins" guarantee rests on this one function.
 */
export async function assembleFromCatalog(
  catalog: Catalog,
  template: Template,
  context: AssembleFromCatalogContext,
): Promise<DocumentTree> {
  const body = await expandIncludes(template.body, (id) => catalog.loadInclude(id));
  return assembleDocument({ ...template, body }, context);
}
