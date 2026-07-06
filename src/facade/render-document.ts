import { LegalDocsError, NotFoundError } from "../core/errors";
import { Readable } from "node:stream";
import type { Catalog } from "../catalog/catalog";
import type { Template } from "../core/template";
import { assembleDocument } from "../core/engine";
import { expandIncludes } from "../core/includes";
import { validatePayload, type PayloadSchemaRegistry } from "../core/payload";
import { resolvePayload, type DerivationRegistry } from "../core/resolve";
import type { HelperRegistry } from "../core/helpers";
import { buildSnapshot, type ClausePin, type Snapshot, type SnapshotMode } from "../core/snapshot";
import { renderTreeToPdf } from "../render-pdf/render-pdf";
import type { RenderTreeOptions } from "../custom-block";
import { renderTreeToHtml } from "../render-html/render-html";
import { renderTreeToDocx } from "../render-docx/render-docx";
import type { CustomBlockRegistry, DegradationMode, OnDegrade } from "../custom-block";
import type { DeepPartial, Theme } from "../theme";

export interface RenderDocumentInput {
  catalog: Catalog;
  template: string;
  /** Selects a family member: the `template` is resolved as a family and this Variant is composed. */
  variant?: string;
  /** Overrides the Template's locale for Clause resolution (with the store's fallback). */
  locale?: string;
  data?: unknown;
  /** Code-side payload schemas, looked up by a Template's `payloadSchema` reference. */
  schemas?: PayloadSchemaRegistry;
  /** Code-side Derivations, looked up by name from a Template's `derivations` list. */
  derivations?: DerivationRegistry;
  /** Extra whitelisted helpers, merged over the defaults. */
  helpers?: HelperRegistry;
  /** Code-side Custom-block implementations, looked up by a `custom` node's `component`. */
  customBlocks?: CustomBlockRegistry;
  /** How a Custom block missing this format degrades (ADR-0005). Defaults to `placeholder`. */
  degradation?: DegradationMode;
  /** A sink for degradation events; when supplied it replaces the default `console.warn`. */
  onDegrade?: OnDegrade;
  format: "pdf" | "html" | "docx";
  /** A partial theme, deep-merged over `defaultTheme`. */
  theme?: DeepPartial<Theme>;
  /** What the returned Snapshot freezes (ADR-0003). Defaults to `full`. */
  snapshotMode?: SnapshotMode;
}

/** Fields every render result carries, regardless of format. */
interface RenderResultBase {
  /** The audit Snapshot for this generation; the consumer persists it (and can re-render from it). */
  snapshot: Snapshot;
  /** Convenience alias for `snapshot.id` — a stable digest of the generation. */
  snapshotId: string;
}

export interface PdfRenderResult extends RenderResultBase {
  format: "pdf";
  buffer: Buffer;
  stream: Readable;
}

export interface HtmlRenderResult extends RenderResultBase {
  format: "html";
  html: string;
}

export interface DocxRenderResult extends RenderResultBase {
  format: "docx";
  buffer: Buffer;
  stream: Readable;
}

/** Discriminated by `format`: PDF/DOCX yield `buffer`/`stream`, HTML yields `html`. */
export type RenderDocumentResult = PdfRenderResult | HtmlRenderResult | DocxRenderResult;

export function renderDocument(input: RenderDocumentInput & { format: "pdf" }): Promise<PdfRenderResult>;
export function renderDocument(input: RenderDocumentInput & { format: "html" }): Promise<HtmlRenderResult>;
export function renderDocument(input: RenderDocumentInput & { format: "docx" }): Promise<DocxRenderResult>;
// Final overload: a caller whose `format` is only known as the union still resolves (to the union result).
export function renderDocument(input: RenderDocumentInput): Promise<RenderDocumentResult>;
export async function renderDocument(input: RenderDocumentInput): Promise<RenderDocumentResult> {
  // A `variant` resolves `template` as a family and composes that member into a concrete Template.
  const template = await input.catalog.getTemplate(input.template, input.variant);
  // A `locale` override resolves Clauses in the requested language (falling back per the store);
  // otherwise the Template's own locale applies. The resolved locale is what the Snapshot freezes.
  const locale = input.locale ?? template.locale;
  // Expand Includes into a concrete, include-free body before tree assembly.
  const body = await expandIncludes(template.body, (id) => input.catalog.loadInclude(id));
  const concrete = { ...template, body };
  const payload = resolveScope(concrete, input);
  const { derived } = resolvePayload(payload, concrete.derivations ?? [], input.derivations ?? {});
  // `$derived` is the reserved namespace, so a payload field literally named `derived` is overwritten.
  const scope = { ...payload, derived };
  // Record every Clause version resolved during assembly, so the Snapshot can pin them for audit.
  const pins: ClausePin[] = [];
  const tree = await assembleDocument(concrete, {
    scope,
    helpers: input.helpers,
    clauses: async (ref, clauseLocale) => {
      const clause = await input.catalog.getClause(ref, clauseLocale);
      // Record both the requested locale (for re-render keying) and the one that actually loaded.
      pins.push({ ref, clause: clause.clause, version: clause.version, locale: clauseLocale, resolvedLocale: clause.locale });
      return clause;
    },
    locale,
  });
  const snapshot = buildSnapshot(
    {
      template: template.template,
      version: template.version,
      ...(template.variant !== undefined ? { variant: template.variant } : {}),
      locale,
      payload: input.data,
      resolved: scope,
      pins,
      tree,
    },
    input.snapshotMode,
  );
  // The Snapshot is format-agnostic (it freezes the tree); only the rendered output differs.
  const treeOptions: RenderTreeOptions = { theme: input.theme, customBlocks: input.customBlocks, degradation: input.degradation, onDegrade: input.onDegrade };
  if (input.format === "html") {
    const html = renderTreeToHtml(tree, treeOptions);
    return { format: "html", html, snapshot, snapshotId: snapshot.id };
  }
  if (input.format === "pdf") {
    const buffer = await renderTreeToPdf(tree, treeOptions);
    return { format: "pdf", buffer, stream: Readable.from(buffer), snapshot, snapshotId: snapshot.id };
  }
  if (input.format === "docx") {
    const buffer = await renderTreeToDocx(tree, treeOptions);
    return { format: "docx", buffer, stream: Readable.from(buffer), snapshot, snapshotId: snapshot.id };
  }
  const unsupported: never = input.format;
  throw new LegalDocsError(`Unsupported format: ${String(unsupported)}`);
}

function resolveScope(template: Template, input: RenderDocumentInput): Record<string, unknown> {
  if (!template.payloadSchema) {
    // Schema is optional: a Template without one binds raw data unvalidated (intentional).
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
