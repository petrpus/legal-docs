import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Catalog } from "../catalog/catalog";
import { assembleTree } from "../core/engine";
import { renderTreeToBuffer } from "../render-pdf/render-pdf";
import type { Theme } from "../render-pdf/theme";

export interface RenderDocumentInput {
  catalog: Catalog;
  template: string;
  /** Accepted for forward-compatibility; only the standalone-template path is implemented. */
  variant?: string;
  data?: unknown;
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
  const template = await input.catalog.getTemplate(input.template);
  const tree = assembleTree(template);
  const buffer = await renderTreeToBuffer(tree, input.theme);
  const snapshotId = createHash("sha256")
    .update(
      JSON.stringify({
        template: template.template,
        version: template.version,
        tree,
        data: input.data ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return { buffer, stream: Readable.from(buffer), snapshotId };
}
