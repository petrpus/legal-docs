import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Catalog } from "../catalog/catalog";
import type { Template } from "../core/template";
import { assembleTree } from "../core/engine";
import { expandIncludes } from "../core/includes";
import { validatePayload, type PayloadSchemaRegistry } from "../core/payload";
import { resolvePayload, type DerivationRegistry } from "../core/resolve";
import type { HelperRegistry } from "../core/helpers";
import { renderTreeToBuffer } from "../render-pdf/render-pdf";
import type { Theme } from "../render-pdf/theme";

export interface RenderDocumentInput {
  catalog: Catalog;
  template: string;
  /** Selects a family member: the `template` is resolved as a family and this Variant is composed. */
  variant?: string;
  data?: unknown;
  /** Code-side payload schemas, looked up by a Template's `payloadSchema` reference. */
  schemas?: PayloadSchemaRegistry;
  /** Code-side Derivations, looked up by name from a Template's `derivations` list. */
  derivations?: DerivationRegistry;
  /** Extra whitelisted helpers, merged over the defaults. */
  helpers?: HelperRegistry;
  format: "pdf";
  theme?: Theme;
}

export interface RenderDocumentResult {
  buffer: Buffer;
  stream: Readable;
  /**
   * Audit handle for the generation. A stub in Phase 1 — a deterministic digest of the inputs, so it
   * is already stable for identical inputs; full Snapshot modes arrive in Phase 2.
   */
  snapshotId: string;
}

export async function renderDocument(input: RenderDocumentInput): Promise<RenderDocumentResult> {
  if (input.format !== "pdf") {
    throw new Error(`Unsupported format: ${String(input.format)}`);
  }
  // A `variant` resolves `template` as a family and composes that member into a concrete Template.
  const template = await input.catalog.getTemplate(input.template, input.variant);
  // Expand Includes into a concrete, include-free body before tree assembly.
  const body = await expandIncludes(template.body, (id) => input.catalog.loadInclude(id));
  const concrete = { ...template, body };
  const payload = resolveScope(concrete, input);
  const { derived } = resolvePayload(payload, concrete.derivations ?? [], input.derivations ?? {});
  // `$derived` is the reserved namespace, so a payload field literally named `derived` is overwritten.
  const scope = { ...payload, derived };
  const tree = await assembleTree(concrete, {
    scope,
    helpers: input.helpers,
    clauses: (ref, locale) => input.catalog.getClause(ref, locale),
    locale: template.locale,
  });
  const buffer = await renderTreeToBuffer(tree, input.theme);
  const snapshotId = createHash("sha256")
    .update(
      JSON.stringify({
        template: template.template,
        version: template.version,
        variant: template.variant ?? null,
        tree,
        data: input.data ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return { buffer, stream: Readable.from(buffer), snapshotId };
}

function resolveScope(template: Template, input: RenderDocumentInput): Record<string, unknown> {
  if (!template.payloadSchema) {
    // Schema is optional: a Template without one binds raw data unvalidated (intentional).
    return isRecord(input.data) ? input.data : {};
  }
  const schema = input.schemas?.[template.payloadSchema];
  if (!schema) {
    throw new Error(`No payload schema registered for "${template.payloadSchema}"`);
  }
  const validated = validatePayload(schema, input.data);
  return isRecord(validated) ? validated : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
