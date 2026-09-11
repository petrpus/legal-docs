import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { PDFParse } from "pdf-parse";
import JSZip from "jszip";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { renderFromSnapshot } from "../src/facade/render-from-snapshot";
import { renderEdited } from "../src/facade/render-edited";
import { verifyEditedSnapshot } from "../src/core/edited-snapshot";
import { EDIT_SET_SCHEMA_VERSION, type EditSet } from "../src/core/edit";
import type { Snapshot } from "../src/core/snapshot";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "fixtures", "snapshot-v1");

const ORIGINAL = "NOTE DOCUMENT";
const EDITED = "AMENDED MEMORANDUM";

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    return (await parser.getText()).text.replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

async function documentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return zip.file("word/document.xml")!.async("string");
}

describe("renderEdited", () => {
  let base: Snapshot;
  let baseHtml: string;
  let edits: EditSet;

  beforeAll(async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const generated = await renderDocument({ catalog, template: "doc", data: {}, format: "html" });
    base = generated.snapshot;
    baseHtml = generated.html;
    // The template's title is the first body node; reword it. (C3 applies `setText`; the remaining
    // ops land in C4, so the clause's richText paragraph is not an editable target yet.)
    expect(base.tree?.body[0]).toMatchObject({ kind: "title", text: ORIGINAL });
    edits = {
      schemaVersion: EDIT_SET_SCHEMA_VERSION,
      baseSnapshotId: base.id,
      ops: [{ op: "setText", path: ["body", 0, "text"], value: EDITED }],
      author: "jana",
      at: "2026-09-11T10:00:00.000Z",
    };
  });

  it("returns the edited Snapshot alongside the output", async () => {
    const out = await renderEdited({ snapshot: base, edits, format: "html" });

    expect(out.format).toBe("html");
    expect(out.snapshotId).toBe(out.snapshot.id);
    expect(out.snapshot.mode).toBe("tree");
    expect(out.snapshot.derivedFrom).toEqual(edits);
    expect(verifyEditedSnapshot(base, out.snapshot)).toEqual({ ok: true });
  });

  it("renders HTML byte-identically to re-rendering the edited Snapshot", async () => {
    const out = await renderEdited({ snapshot: base, edits, format: "html" });

    // The facade is a convenience, not a second renderer: the edited Snapshot is the artifact, and
    // re-rendering it later must reproduce exactly what the editing pass exported.
    const rerendered = await renderFromSnapshot(out.snapshot, { format: "html" });
    expect(out.html).toBe(rerendered.html);
    expect(out.html).toContain(EDITED);
    expect(out.html).not.toContain(ORIGINAL);
  });

  it("carries the edit into PDF", async () => {
    const out = await renderEdited({ snapshot: base, edits, format: "pdf" });

    const text = await pdfText(out.buffer);
    expect(text).toContain(EDITED);
    expect(text).not.toContain(ORIGINAL);
    expect(text).toEqual(await pdfText((await renderFromSnapshot(out.snapshot, { format: "pdf" })).buffer));
  });

  it("carries the edit into DOCX", async () => {
    const out = await renderEdited({ snapshot: base, edits, format: "docx" });

    const xml = await documentXml(out.buffer);
    expect(xml).toContain(EDITED);
    expect(xml).not.toContain(ORIGINAL);
  });

  it("leaves the base Snapshot and its output untouched", async () => {
    const before = structuredClone(base);

    await renderEdited({ snapshot: base, edits, format: "html" });

    expect(base).toEqual(before);
    expect((await renderFromSnapshot(base, { format: "html" })).html).toBe(baseHtml);
  });

  it("rejects an Edit set addressing another Snapshot", async () => {
    const foreign: EditSet = { ...edits, baseSnapshotId: "0000000000000000" };

    await expect(renderEdited({ snapshot: base, edits: foreign, format: "html" })).rejects.toThrow(/0000000000000000/);
  });
});
