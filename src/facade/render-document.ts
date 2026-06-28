import { Readable } from "node:stream";
import type { Catalog } from "../catalog/catalog";
import type { Template } from "../core/template";
import { assembleTree } from "../core/engine";
import { expandIncludes } from "../core/includes";
import { validatePayload, type PayloadSchemaRegistry } from "../core/payload";
import { resolvePayload, type DerivationRegistry } from "../core/resolve";
import type { HelperRegistry } from "../core/helpers";
import { buildSnapshot, type ClausePin, type Snapshot, type SnapshotMode } from "../core/snapshot";
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
  /** What the returned Snapshot freezes (ADR-0003). Defaults to `full`. */
  snapshotMode?: SnapshotMode;
}

export interface RenderDocumentResult {
  buffer: Buffer;
  stream: Readable;
  /** The audit Snapshot for this generation; the consumer persists it (and can re-render from it). */
  snapshot: Snapshot;
  /** Convenience alias for `snapshot.id` — a stable digest of the generation. */
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
  // Record every Clause version resolved during assembly, so the Snapshot can pin them for audit.
  const pins: ClausePin[] = [];
  const tree = await assembleTree(concrete, {
    scope,
    helpers: input.helpers,
    clauses: async (ref, locale) => {
      const clause = await input.catalog.getClause(ref, locale);
      pins.push({ ref, clause: clause.clause, version: clause.version, locale });
      return clause;
    },
    locale: template.locale,
  });
  const buffer = await renderTreeToBuffer(tree, input.theme);
  const snapshot = buildSnapshot(
    {
      template: template.template,
      version: template.version,
      ...(template.variant !== undefined ? { variant: template.variant } : {}),
      locale: template.locale,
      payload: input.data,
      resolved: scope,
      pins,
      tree,
    },
    input.snapshotMode,
  );
  return { buffer, stream: Readable.from(buffer), snapshot, snapshotId: snapshot.id };
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
