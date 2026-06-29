import { Readable } from "node:stream";
import type { Catalog } from "../catalog/catalog";
import { assembleTree, type ClauseResolver } from "../core/engine";
import { expandIncludes } from "../core/includes";
import type { HelperRegistry } from "../core/helpers";
import type { ClausePin, Snapshot } from "../core/snapshot";
import type { DocumentTree } from "../core/document-tree";
import { renderTreeToBuffer } from "../render-pdf/render-pdf";
import { renderTreeToHtml } from "../render-html/render-html";
import { renderTreeToDocx } from "../render-docx/render-docx";
import type { CustomBlockRegistry, DegradationMode, OnDegrade } from "../render-pdf/custom-block";
import type { Theme } from "../render-pdf/theme";

export interface RenderFromSnapshotOptions {
  /** Required for a `pins`-mode Snapshot (which re-runs the engine); unused for `full`/`tree`. */
  catalog?: Catalog;
  /** Extra whitelisted helpers, needed only if a `pins` re-render's template uses custom helpers. */
  helpers?: HelperRegistry;
  /**
   * Code-side Custom-block implementations. Required if the Snapshot's tree contains `custom` nodes —
   * the implementation is code, not frozen data, so it must be supplied for `full`/`tree` and `pins`.
   */
  customBlocks?: CustomBlockRegistry;
  /** How a Custom block missing this format degrades (defaults to `placeholder`). */
  degradation?: DegradationMode;
  /** A sink for degradation events; when supplied it replaces the default `console.warn`. */
  onDegrade?: OnDegrade;
  /** Output format (defaults to `pdf`). */
  format?: "pdf" | "html" | "docx";
  theme?: Theme;
}

export interface PdfFromSnapshot {
  format: "pdf";
  buffer: Buffer;
  stream: Readable;
}

export interface HtmlFromSnapshot {
  format: "html";
  html: string;
}

export interface DocxFromSnapshot {
  format: "docx";
  buffer: Buffer;
  stream: Readable;
}

/** Discriminated by `options.format`. */
export type RenderFromSnapshotResult = PdfFromSnapshot | HtmlFromSnapshot | DocxFromSnapshot;

/**
 * Deterministically re-render a document from its {@link Snapshot}.
 * - `full` / `tree`: render the frozen DocumentNode tree directly — immune to later catalog and
 *   engine changes.
 * - `pins`: re-run the engine over the frozen version pins (requires a `catalog`); the clause
 *   versions are pinned to the Snapshot, so a moved `@latest` does not change the output, but the
 *   catalog must still hold those versions and the template structure is read from it.
 */
export function renderFromSnapshot(
  snapshot: Snapshot,
  options?: RenderFromSnapshotOptions & { format?: "pdf" },
): Promise<PdfFromSnapshot>;
export function renderFromSnapshot(
  snapshot: Snapshot,
  options: RenderFromSnapshotOptions & { format: "html" },
): Promise<HtmlFromSnapshot>;
export function renderFromSnapshot(
  snapshot: Snapshot,
  options: RenderFromSnapshotOptions & { format: "docx" },
): Promise<DocxFromSnapshot>;
// Final overload: a caller whose `format` is only known as the union still resolves.
export function renderFromSnapshot(
  snapshot: Snapshot,
  options?: RenderFromSnapshotOptions,
): Promise<RenderFromSnapshotResult>;
export async function renderFromSnapshot(
  snapshot: Snapshot,
  options: RenderFromSnapshotOptions = {},
): Promise<RenderFromSnapshotResult> {
  const tree = snapshot.tree ?? (await reassembleFromPins(snapshot, options));
  const format = options.format ?? "pdf";
  if (format === "html") {
    return { format: "html", html: renderTreeToHtml(tree, options.theme, options.customBlocks, options.degradation, options.onDegrade) };
  }
  if (format === "pdf") {
    const buffer = await renderTreeToBuffer(tree, options.theme, options.customBlocks, options.degradation, options.onDegrade);
    return { format: "pdf", buffer, stream: Readable.from(buffer) };
  }
  if (format === "docx") {
    const buffer = await renderTreeToDocx(tree, options.theme, options.customBlocks, options.degradation, options.onDegrade);
    return { format: "docx", buffer, stream: Readable.from(buffer) };
  }
  const unsupported: never = format;
  throw new Error(`Unsupported format: ${String(unsupported)}`);
}

async function reassembleFromPins(
  snapshot: Snapshot,
  options: RenderFromSnapshotOptions,
): Promise<DocumentTree> {
  const { catalog } = options;
  if (!catalog) {
    throw new Error("renderFromSnapshot: a `pins`-mode Snapshot needs a `catalog` to re-render");
  }
  const template = await catalog.getTemplate(snapshot.template, snapshot.variant);
  const body = await expandIncludes(template.body, (id) => catalog.loadInclude(id));
  return assembleTree(
    { ...template, body },
    {
      scope: snapshot.resolved ?? {},
      helpers: options.helpers,
      clauses: pinnedResolver(snapshot.pins ?? [], catalog),
      locale: snapshot.locale,
    },
  );
}

/** A Clause resolver locked to the Snapshot's pinned versions, regardless of the catalog's `@latest`. */
function pinnedResolver(pins: ClausePin[], catalog: Catalog): ClauseResolver {
  const byRef = new Map<string, ClausePin>();
  for (const pin of pins) byRef.set(`${pin.ref}|${pin.locale}`, pin);
  return async (ref, locale) => {
    const pin = byRef.get(`${ref}|${locale}`);
    if (!pin) {
      throw new Error(`Snapshot has no pin for clause "${ref}" (${locale}) — cannot re-render`);
    }
    try {
      // Load the exact locale file that originally resolved (not a re-run of the store's fallback).
      return await catalog.getClause(`${pin.clause}@v${pin.version}`, pin.resolvedLocale ?? locale);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Pinned clause "${pin.clause}@v${pin.version}" cannot be resolved: ${reason}`,
        { cause },
      );
    }
  };
}
