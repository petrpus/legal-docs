import type { Readable } from "node:stream";
import { buildEditedSnapshot, type EditedSnapshot } from "../core/edited-snapshot";
import type { EditSet } from "../core/edit";
import type { Snapshot } from "../core/snapshot";
import { renderTree } from "./render-tree";
import type { CustomBlockRegistry, DegradationMode, OnDegrade } from "../custom-block";
import type { DeepPartial, Theme } from "../theme";

export interface RenderEditedInput {
  /** The base Snapshot the edits were authored against — `full` or `tree` mode (it must carry a tree). */
  snapshot: Snapshot;
  /** The Edit set to apply; its `baseSnapshotId` must name `snapshot`. */
  edits: EditSet;
  /**
   * Code-side Custom-block implementations. Required if the tree contains `custom` nodes — the
   * implementation is code, not frozen data (ADR-0005). Editing never changes that.
   */
  customBlocks?: CustomBlockRegistry;
  /** How a Custom block missing this format degrades (defaults to `placeholder`). */
  degradation?: DegradationMode;
  /** A sink for degradation events; when supplied it replaces the default `console.warn`. */
  onDegrade?: OnDegrade;
  /** Output format (defaults to `pdf`). */
  format?: "pdf" | "html" | "docx";
  theme?: DeepPartial<Theme>;
}

/** The edited Snapshot every `renderEdited` result carries — the artifact to persist. */
interface EditedResultBase {
  /** The edited Snapshot (`tree` mode, with `derivedFrom`); re-rendering it reproduces this output. */
  snapshot: EditedSnapshot;
  /** Convenience alias for `snapshot.id`. */
  snapshotId: string;
}

export interface PdfEditedResult extends EditedResultBase {
  format: "pdf";
  buffer: Buffer;
  stream: Readable;
}

export interface HtmlEditedResult extends EditedResultBase {
  format: "html";
  html: string;
}

export interface DocxEditedResult extends EditedResultBase {
  format: "docx";
  buffer: Buffer;
  stream: Readable;
}

/** Discriminated by `input.format`. */
export type RenderEditedResult = PdfEditedResult | HtmlEditedResult | DocxEditedResult;

/**
 * Export a document with an {@link EditSet} applied, and get back the edited Snapshot (ADR-0014).
 *
 * A thin facade over `buildEditedSnapshot` + the shared tree dispatch: the edit is frozen as a
 * Snapshot FIRST, so what is exported is exactly what `renderFromSnapshot(result.snapshot)` re-renders
 * later — there is no path by which an exported document exists without an audit record. The base
 * Snapshot is not modified, and a `pins`-mode base is rejected (there is no frozen tree to edit).
 */
export function renderEdited(input: RenderEditedInput & { format?: "pdf" }): Promise<PdfEditedResult>;
export function renderEdited(input: RenderEditedInput & { format: "html" }): Promise<HtmlEditedResult>;
export function renderEdited(input: RenderEditedInput & { format: "docx" }): Promise<DocxEditedResult>;
// Final overload: a caller whose `format` is only known as the union still resolves (to the union result).
export function renderEdited(input: RenderEditedInput): Promise<RenderEditedResult>;
export async function renderEdited(input: RenderEditedInput): Promise<RenderEditedResult> {
  const snapshot = buildEditedSnapshot(input.snapshot, input.edits);
  const output = await renderTree(snapshot.tree, input.format ?? "pdf", {
    theme: input.theme,
    customBlocks: input.customBlocks,
    degradation: input.degradation,
    onDegrade: input.onDegrade,
  });
  return { ...output, snapshot, snapshotId: snapshot.id };
}
