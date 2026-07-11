/**
 * Browser-safe subset of the library, for client-side use (e.g. the in-browser demo bundled from this
 * entry into `docs/assets/browser-demo.js` — see `tsup.config.ts`). Deliberately excludes anything that
 * pulls in a Node built-in or a Node-only renderer dependency: `FileCatalogStore` (`node:fs`), the
 * `Catalog` facade class (its `fromDir` reaches `FileCatalogStore` via a dynamic import that esbuild
 * still code-splits out as a reachable chunk), the Snapshot audit trail (`node:crypto`), and the
 * PDF/DOCX renderers (`@react-pdf/renderer`, `docx`). Works directly against a `CatalogStore` — in
 * practice `MemoryCatalogStore`, seeded in-memory — via `resolveTemplate`/`resolveClause`
 * (`src/catalog/resolve.ts`), the same resolution logic `Catalog.getTemplate`/`getClause` call.
 *
 * Not part of the published npm package surface (see `package.json#exports`) — this is a separate
 * build target, not a public entry point of `@petrpus/legal-docs`.
 */
import type { CatalogStore } from "./catalog/catalog-store";
import { MemoryCatalogStore, type MemoryCatalogSeed } from "./catalog/memory-catalog-store";
import { resolveClause, resolveTemplate } from "./catalog/resolve";
import type { DocumentTree } from "./core/document-tree";
import { assembleDocument } from "./core/engine";
import { NotFoundError } from "./core/errors";
import { ExpressionError, type ExpressionLocation } from "./core/expression";
import type { HelperRegistry } from "./core/helpers";
import { expandIncludes } from "./core/includes";
import { validatePayload, type PayloadSchemaRegistry } from "./core/payload";
// Re-exported so the demo page can build a `ZodType` for its PayloadSchemaRegistry from the SAME
// bundle. No new dependency: zod is already bundled via `validatePayload`; re-exporting the `z` value
// adds negligible weight and lets the demo seed a payload schema (issue #129, scenario 1).
import { z } from "zod";
import { resolvePayload, type DerivationRegistry } from "./core/resolve";
import type { Template } from "./core/template";
import { renderTreeToHtml } from "./render-html/render-html";
import { mergeTheme, defaultTheme, type DeepPartial, type Theme } from "./theme";

export {
  MemoryCatalogStore,
  resolveTemplate,
  resolveClause,
  renderTreeToHtml,
  mergeTheme,
  defaultTheme,
  validatePayload,
  resolvePayload,
  // The class VALUE (not only the type) so the demo page can `instanceof ExpressionError` across the
  // bundle boundary — instanceof is only safe when both sides import it from this same bundle.
  ExpressionError,
  // The zod value, so the demo page can build a payload schema for its registry (see import note).
  z,
};
export type { CatalogStore, MemoryCatalogSeed, PayloadSchemaRegistry, DerivationRegistry, HelperRegistry, DeepPartial, Theme };
export type { DocumentTree };
export type { ExpressionLocation };

export interface RenderHtmlInBrowserInput {
  store: CatalogStore;
  template: string;
  /** Selects a family member: `template` is resolved as a family and this Variant is composed. */
  variant?: string;
  /** Overrides the Template's locale for Clause resolution. */
  locale?: string;
  data?: unknown;
  /** Code-side payload schemas, looked up by a Template's `payloadSchema` reference. */
  schemas?: PayloadSchemaRegistry;
  /** Code-side Derivations, looked up by name from a Template's `derivations` list. */
  derivations?: DerivationRegistry;
  /** Extra whitelisted helpers, merged over the defaults. */
  helpers?: HelperRegistry;
  /** A partial theme, deep-merged over `defaultTheme`. */
  theme?: DeepPartial<Theme>;
}

/**
 * A single Clause reference resolved during assembly — the browser-side analogue of `renderDocument`'s
 * `ClausePin` (src/facade/render-document.ts), minus the audit Snapshot it feeds. Recorded so the demo
 * inspector can show which concrete Clause version/locale each `clause:` reference resolved to.
 */
export interface ClauseReference {
  /** The reference as authored (`counterparts@v1`, `aml.intro@latest`, …). */
  ref: string;
  /** The concrete Clause id it resolved to. */
  clause: string;
  /** The concrete version that loaded. */
  version: number;
  /** The locale the assembly requested (the document's resolved locale). */
  locale: string;
  /** The locale of the Clause file that actually loaded — equal to `locale` unless the store fell back. */
  resolvedLocale: string;
}

/** The intermediate artifacts of one browser render, exposed by `inspectDocument` for the demo inspector. */
export interface InspectDocumentResult {
  /** The validated payload bound as scope (schema-checked when the Template declares a `payloadSchema`). */
  payload: Record<string, unknown>;
  /** The Resolved payload: `{ ...payload, derived }`, carrying the `$derived.*` namespace. */
  resolved: Record<string, unknown>;
  /** The assembled, renderer-agnostic DocumentTree. */
  tree: DocumentTree;
  /** Every Clause reference resolved during assembly, in resolution order. */
  references: ClauseReference[];
  /** The rendered HTML fragment. */
  html: string;
}

/**
 * The shared client-side pipeline — resolveTemplate → locale → expandIncludes → scope → `resolvePayload`
 * → `assembleDocument` (with a recording Clause resolver) → `renderTreeToHtml` — computed once and
 * returned as its intermediate artifacts. Both `renderHtmlInBrowser` (html only) and `inspectDocument`
 * (all artifacts) delegate here, so there is a single pipeline. Mirrors `renderDocument`'s `pins` pattern
 * for recording references, but carries NO Snapshot and NO `node:crypto` (ADR-0012).
 */
async function runBrowserPipeline(input: RenderHtmlInBrowserInput): Promise<InspectDocumentResult> {
  const template = await resolveTemplate(input.store, input.template, input.variant);
  const locale = input.locale ?? template.locale;
  const body = await expandIncludes(template.body, (id) => input.store.loadInclude(id));
  const concrete: Template = { ...template, body };
  const payload = scopeFromData(concrete, input);
  const { derived } = resolvePayload(payload, concrete.derivations ?? [], input.derivations ?? {});
  const resolved = { ...payload, derived };
  const references: ClauseReference[] = [];
  const tree = await assembleDocument(concrete, {
    scope: resolved,
    helpers: input.helpers,
    clauses: async (ref, clauseLocale) => {
      const clause = await resolveClause(input.store, ref, clauseLocale);
      references.push({ ref, clause: clause.clause, version: clause.version, locale: clauseLocale, resolvedLocale: clause.locale });
      return clause;
    },
    locale,
  });
  const html = renderTreeToHtml(tree, { theme: input.theme });
  return { payload, resolved, tree, references, html };
}

/**
 * Render a Template to an HTML fragment entirely client-side — the same pipeline as
 * `renderDocument({ format: "html" })`, minus the audit Snapshot (which needs `node:crypto`, unavailable
 * in a browser). Intended for demos/playgrounds, not as a Snapshot-producing substitute for the facade.
 */
export async function renderHtmlInBrowser(input: RenderHtmlInBrowserInput): Promise<string> {
  return (await runBrowserPipeline(input)).html;
}

/**
 * Run the same client-side pipeline as `renderHtmlInBrowser` but expose every intermediate artifact
 * (validated payload, Resolved payload with `$derived.*`, assembled DocumentTree, resolved Clause
 * references, rendered HTML) — the data behind the demo's pipeline inspector. Shares `runBrowserPipeline`
 * with `renderHtmlInBrowser`, so `inspectDocument(input).html === renderHtmlInBrowser(input)`.
 */
export async function inspectDocument(input: RenderHtmlInBrowserInput): Promise<InspectDocumentResult> {
  return runBrowserPipeline(input);
}

function scopeFromData(template: Template, input: RenderHtmlInBrowserInput): Record<string, unknown> {
  if (!template.payloadSchema) {
    return isRecord(input.data) ? input.data : {};
  }
  const schema = input.schemas?.[template.payloadSchema];
  if (!schema) {
    throw new NotFoundError("schema", { id: template.payloadSchema }, `No payload schema registered for "${template.payloadSchema}"`);
  }
  const validated = validatePayload(schema, input.data);
  return isRecord(validated) ? validated : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
