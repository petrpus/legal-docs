import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { PDFParse } from "pdf-parse";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { createElement } from "react";
import { Text } from "@react-pdf/renderer";
import { renderTreeToHtml } from "../src/render-html/render-html";
import { renderTreeToDocx } from "../src/render-docx/render-docx";
import { defaultTheme } from "../src/theme";
import type { CustomBlock, CustomBlockRegistry, DegradationEvent } from "../src/custom-block";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "fixtures", "custom");

// Simulate an untyped caller: a registered block with no `pdf` implementation. `pdf` is required by
// the type, so this deliberate bypass is the only way to reach the degradation branch for the PDF
// renderer (it fires naturally for a missing `html`/`docx` block).
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

  it("fails hard in throw mode, notifying neither console.warn nor the sink", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = await Catalog.fromDir(catalogDir);
    const events: DegradationEvent[] = [];

    await expect(
      renderDocument({
        catalog, template: "doc", data: { title: "x" }, customBlocks, degradation: "throw", format: "pdf",
        onDegrade: (e) => events.push(e),
      }),
    ).rejects.toThrow(/Custom block "banner" cannot render in "pdf"/);
    expect(warn).not.toHaveBeenCalled();
    expect(events).toEqual([]); // throw mode short-circuits before notifying the sink
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

  it("routes degradation to an onDegrade sink instead of console.warn (renderer level)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: DegradationEvent[] = [];

    const html = renderTreeToHtml([{ kind: "custom", component: "banner", props: undefined }], {
      theme: defaultTheme,
      customBlocks: { banner: { pdf: () => createElement(Text, null, "x") } }, // no html → degrades
      degradation: "placeholder",
      onDegrade: (event) => events.push(event),
    });

    expect(events).toEqual([
      { component: "banner", format: "html", marker: "[unsupported block: banner in html]" },
    ]);
    expect(warn).not.toHaveBeenCalled(); // the sink replaces console.warn
    expect(html).toContain("[unsupported block: banner in html]"); // still a visible placeholder
    warn.mockRestore();
  });

  it("routes degradation to an onDegrade sink in the DOCX renderer too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: DegradationEvent[] = [];

    await renderTreeToDocx([{ kind: "custom", component: "banner", props: undefined }], {
      theme: defaultTheme,
      customBlocks: { banner: { pdf: () => createElement(Text, null, "x") } }, // no docx → degrades
      degradation: "placeholder",
      onDegrade: (event) => events.push(event),
    });

    expect(events).toEqual([
      { component: "banner", format: "docx", marker: "[unsupported block: banner in docx]" },
    ]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("threads onDegrade through the facade", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = await Catalog.fromDir(catalogDir);
    const events: DegradationEvent[] = [];

    await renderDocument({
      catalog, template: "doc", data: { title: "x" }, customBlocks, format: "pdf", onDegrade: (e) => events.push(e),
    });

    expect(events).toEqual([
      { component: "banner", format: "pdf", marker: "[unsupported block: banner in pdf]" },
    ]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
