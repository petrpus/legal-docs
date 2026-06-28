import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFParse } from "pdf-parse";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { renderFromSnapshot } from "../src/facade/render-from-snapshot";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = (name: string) => path.join(here, "fixtures", name);

async function text(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const { text } = await parser.getText();
    return text.replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

async function generate(catalogDir: string, snapshotMode: "full" | "tree" | "pins") {
  const catalog = await Catalog.fromDir(catalogDir);
  const { snapshot, buffer } = await renderDocument({ catalog, template: "doc", data: {}, format: "pdf", snapshotMode });
  return { snapshot, original: await text(buffer) };
}

describe("renderFromSnapshot", () => {
  it("re-renders a full snapshot to parity, immune to a changed catalog", async () => {
    const { snapshot, original } = await generate(dir("snapshot-v1"), "full");
    // Pass the *changed* catalog (note@latest now resolves to v2) — the frozen tree must win.
    const changed = await Catalog.fromDir(dir("snapshot-v2"));

    const out = await text((await renderFromSnapshot(snapshot, { catalog: changed })).buffer);

    expect(out).toEqual(original); // parity with the original generation
    expect(out).toContain("Original note wording.");
    expect(out).not.toContain("Newer note wording.");
  });

  it("re-runs the engine for a pins snapshot to parity, pinning the version as @latest moves", async () => {
    const { snapshot, original } = await generate(dir("snapshot-v1"), "pins");
    expect(snapshot.tree).toBeUndefined();
    // snapshot-v2's note@latest is now v2; the pin must keep the re-render on v1.
    const changed = await Catalog.fromDir(dir("snapshot-v2"));

    const out = await text((await renderFromSnapshot(snapshot, { catalog: changed })).buffer);

    expect(out).toEqual(original); // parity despite the moved @latest
    expect(out).not.toContain("Newer note wording.");
  });

  it("renders a tree-mode snapshot from its frozen tree with no catalog", async () => {
    const { snapshot, original } = await generate(dir("snapshot-v1"), "tree");
    expect(snapshot.pins).toBeUndefined();

    const out = await text((await renderFromSnapshot(snapshot)).buffer);

    expect(out).toEqual(original);
  });

  it("fails fast when a pins snapshot's pinned version is gone from the catalog", async () => {
    const { snapshot } = await generate(dir("snapshot-v1"), "pins");
    const gone = await Catalog.fromDir(dir("snapshot-gone")); // only note@v2 exists

    await expect(renderFromSnapshot(snapshot, { catalog: gone })).rejects.toThrow(
      /Pinned clause "note@v1" cannot be resolved/,
    );
  });

  it("fails fast when a pins snapshot is re-rendered without a catalog", async () => {
    const { snapshot } = await generate(dir("snapshot-v1"), "pins");

    await expect(renderFromSnapshot(snapshot)).rejects.toThrow(/needs a `catalog`/);
  });

  it("re-renders deterministically (identical output across runs)", async () => {
    const { snapshot } = await generate(dir("snapshot-v1"), "full");

    const a = await renderFromSnapshot(snapshot);
    const b = await renderFromSnapshot(snapshot);

    expect(await text(a.buffer)).toEqual(await text(b.buffer));
  });
});
