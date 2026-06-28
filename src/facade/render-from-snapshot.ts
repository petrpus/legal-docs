import { Readable } from "node:stream";
import type { Catalog } from "../catalog/catalog";
import { assembleTree, type ClauseResolver } from "../core/engine";
import { expandIncludes } from "../core/includes";
import type { HelperRegistry } from "../core/helpers";
import type { ClausePin, Snapshot } from "../core/snapshot";
import type { DocumentTree } from "../core/document-tree";
import { renderTreeToBuffer } from "../render-pdf/render-pdf";
import type { Theme } from "../render-pdf/theme";

export interface RenderFromSnapshotOptions {
  /** Required for a `pins`-mode Snapshot (which re-runs the engine); unused for `full`/`tree`. */
  catalog?: Catalog;
  /** Extra whitelisted helpers, needed only if a `pins` re-render's template uses custom helpers. */
  helpers?: HelperRegistry;
  theme?: Theme;
}

export interface RenderFromSnapshotResult {
  buffer: Buffer;
  stream: Readable;
}

/**
 * Deterministically re-render a document from its {@link Snapshot}.
 * - `full` / `tree`: render the frozen DocumentNode tree directly — immune to later catalog and
 *   engine changes.
 * - `pins`: re-run the engine over the frozen version pins (requires a `catalog`); the clause
 *   versions are pinned to the Snapshot, so a moved `@latest` does not change the output, but the
 *   catalog must still hold those versions and the template structure is read from it.
 */
export async function renderFromSnapshot(
  snapshot: Snapshot,
  options: RenderFromSnapshotOptions = {},
): Promise<RenderFromSnapshotResult> {
  const tree = snapshot.tree ?? (await reassembleFromPins(snapshot, options));
  const buffer = await renderTreeToBuffer(tree, options.theme);
  return { buffer, stream: Readable.from(buffer) };
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
      return await catalog.getClause(`${pin.clause}@v${pin.version}`, locale);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Pinned clause "${pin.clause}@v${pin.version}" cannot be resolved: ${reason}`,
        { cause },
      );
    }
  };
}
