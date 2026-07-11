import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { Text } from "@react-pdf/renderer";
import { PDFParse } from "pdf-parse";
import { z } from "zod";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { renderFromSnapshot } from "../src/facade/render-from-snapshot";
import type { CustomBlock, CustomBlockRegistry } from "../src/custom-block";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "fixtures", "custom");

const bannerSchema = z.object({ label: z.string() });
const customBlocks: CustomBlockRegistry = {
  banner: { schema: bannerSchema, pdf: (props) => createElement(Text, null, bannerSchema.parse(props).label) },
};

async function text(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const { text } = await parser.getText();
    return text.replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

async function generate(snapshotMode: "full" | "pins") {
  const catalog = await Catalog.fromDir(catalogDir);
  const { snapshot, buffer } = await renderDocument({
    catalog, template: "doc", data: { title: "SNAP CUSTOM" }, customBlocks, format: "pdf", snapshotMode,
  });
  return { snapshot, original: await text(buffer) };
}

describe("renderFromSnapshot with custom nodes", () => {
  it("re-renders a full snapshot whose tree holds a custom node, to parity", async () => {
    const { snapshot, original } = await generate("full");

    const out = await text((await renderFromSnapshot(snapshot, { customBlocks })).buffer);

    expect(out).toEqual(original);
    expect(out).toContain("SNAP CUSTOM");
  });

  it("re-assembles and renders a pins snapshot's custom node", async () => {
    const { snapshot, original } = await generate("pins");
    expect(snapshot.tree).toBeUndefined();
    const catalog = await Catalog.fromDir(catalogDir);

    const out = await text((await renderFromSnapshot(snapshot, { catalog, customBlocks })).buffer);

    expect(out).toEqual(original);
  });

  it("fails fast on both the full and pins paths without customBlocks", async () => {
    const full = await generate("full");
    await expect(renderFromSnapshot(full.snapshot)).rejects.toThrow(/"banner" is not registered/);

    const pins = await generate("pins");
    const catalog = await Catalog.fromDir(catalogDir);
    await expect(renderFromSnapshot(pins.snapshot, { catalog })).rejects.toThrow(
      /"banner" is not registered/,
    );
  });

  it("threads the degradation mode into re-render", async () => {
    // Generate with a working block (so the snapshot tree has the custom node), then re-render with a
    // block lacking `pdf` to drive degradation — proving `options.degradation` reaches the renderer.
    const { snapshot } = await generate("full");
    const broken: CustomBlockRegistry = { banner: {} as unknown as CustomBlock };

    await expect(
      renderFromSnapshot(snapshot, { customBlocks: broken, degradation: "throw" }),
    ).rejects.toThrow(/cannot render in "pdf"/);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await text((await renderFromSnapshot(snapshot, { customBlocks: broken })).buffer);
    expect(out).toContain("[unsupported block: banner in pdf]");
    warn.mockRestore();
  });
});
