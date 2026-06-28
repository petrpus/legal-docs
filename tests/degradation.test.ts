import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { PDFParse } from "pdf-parse";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { createElement } from "react";
import { Text } from "@react-pdf/renderer";
import type { CustomBlock, CustomBlockRegistry } from "../src/render-pdf/custom-block";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "fixtures", "custom");

// Simulate an untyped caller / a future format: a registered block with no `pdf` implementation.
// `pdf` is required by the type, so this deliberate bypass is the only way to reach the degradation
// branch for the PDF renderer (it goes live for html/docx in Phases 4–5).
const missingPdf = {} as unknown as CustomBlock;
const customBlocks: CustomBlockRegistry = { banner: missingPdf };

async function text(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const { text } = await parser.getText();
    return text.replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

describe("Degradation contract", () => {
  it("emits a visible, logged placeholder by default (never silent)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = await Catalog.fromDir(catalogDir);

    const { buffer } = await renderDocument({
      catalog, template: "doc", data: { title: "x" }, customBlocks, format: "pdf",
    });

    expect(await text(buffer)).toContain("[unsupported block: banner in pdf]");
    expect(warn).toHaveBeenCalledWith("[unsupported block: banner in pdf]");
    warn.mockRestore();
  });

  it("fails hard in throw mode, with no placeholder logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = await Catalog.fromDir(catalogDir);

    await expect(
      renderDocument({
        catalog, template: "doc", data: { title: "x" }, customBlocks, degradation: "throw", format: "pdf",
      }),
    ).rejects.toThrow(/Custom block "banner" cannot render in "pdf"/);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still hard-errors an UNregistered component even in placeholder mode (not degraded)", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    // A real, well-formed block — but registered under the wrong name, so `banner` is unregistered.
    const wrongName: CustomBlockRegistry = {
      other: { pdf: () => createElement(Text, null, "x") },
    };

    await expect(
      renderDocument({
        catalog, template: "doc", data: { title: "x" }, customBlocks: wrongName, degradation: "placeholder", format: "pdf",
      }),
    ).rejects.toThrow(/Custom block "banner" is not registered/);
  });
});
