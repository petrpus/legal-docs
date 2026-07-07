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
import { assembleDocument } from "./core/engine";
import { NotFoundError } from "./core/errors";
import type { HelperRegistry } from "./core/helpers";
import { expandIncludes } from "./core/includes";
import { validatePayload, type PayloadSchemaRegistry } from "./core/payload";
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
};
export type { CatalogStore, MemoryCatalogSeed, PayloadSchemaRegistry, DerivationRegistry, HelperRegistry, DeepPartial, Theme };

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
 * Render a Template to an HTML fragment entirely client-side — the same pipeline as
 * `renderDocument({ format: "html" })`, minus the audit Snapshot (which needs `node:crypto`, unavailable
 * in a browser). Intended for demos/playgrounds, not as a Snapshot-producing substitute for the facade.
 */
export async function renderHtmlInBrowser(input: RenderHtmlInBrowserInput): Promise<string> {
  const template = await resolveTemplate(input.store, input.template, input.variant);
  const locale = input.locale ?? template.locale;
  const body = await expandIncludes(template.body, (id) => input.store.loadInclude(id));
  const concrete: Template = { ...template, body };
  const payload = scopeFromData(concrete, input);
  const { derived } = resolvePayload(payload, concrete.derivations ?? [], input.derivations ?? {});
  const scope = { ...payload, derived };
  const tree = await assembleDocument(concrete, {
    scope,
    helpers: input.helpers,
    clauses: (ref, clauseLocale) => resolveClause(input.store, ref, clauseLocale),
    locale,
  });
  return renderTreeToHtml(tree, { theme: input.theme });
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
