import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { Text } from "@react-pdf/renderer";
import { Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { z } from "zod";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { renderFromSnapshot } from "../src/facade/render-from-snapshot";
import type { CustomBlockRegistry } from "../src/custom-block";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "..", "legal-docs");
const customDir = path.join(here, "fixtures", "custom");

async function docXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("no word/document.xml");
  return file.async("string");
}

const bannerSchema = z.object({ label: z.string() });
const bannerBlocks: CustomBlockRegistry = {
  banner: {
    schema: bannerSchema,
    pdf: () => createElement(Text, null, "x"),
    docx: (props) => [new Paragraph({ children: [new TextRun(bannerSchema.parse(props).label)] })],
  },
};

describe("renderDocument docx dispatch", () => {
  it("returns a .docx buffer whose text matches", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const result = await renderDocument({ catalog, template: "hello", data: {}, format: "docx" });

    expect(result.format).toBe("docx");
    expect(result.buffer.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(await docXml(result.buffer)).toContain("DECLARATION");
  });

  it("discriminates the docx result type and accepts a runtime union format", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const docx = await renderDocument({ catalog, template: "hello", data: {}, format: "docx" });
    // @ts-expect-error a DOCX result has no `html`
    void docx.html;
    expect(docx.buffer).toBeInstanceOf(Buffer);

    const fmt: "pdf" | "html" | "docx" = "docx";
    const dyn = await renderDocument({ catalog, template: "hello", data: {}, format: fmt });
    expect(dyn.format).toBe("docx");
  });

  it("produces the same snapshotId across pdf, html and docx", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const pdf = await renderDocument({ catalog, template: "hello", data: {}, format: "pdf" });
    const html = await renderDocument({ catalog, template: "hello", data: {}, format: "html" });
    const docx = await renderDocument({ catalog, template: "hello", data: {}, format: "docx" });

    expect(html.snapshotId).toBe(pdf.snapshotId);
    expect(docx.snapshotId).toBe(pdf.snapshotId);
  });

  it("degrades a custom block missing its docx impl when rendering to DOCX (facade-level)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = await Catalog.fromDir(customDir);
    const docxless: CustomBlockRegistry = { banner: { pdf: () => createElement(Text, null, "x") } };

    const result = await renderDocument({
      catalog, template: "doc", data: { title: "x" }, customBlocks: docxless, format: "docx",
    });

    expect(await docXml(result.buffer)).toContain("[unsupported block: banner in docx]");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("renderFromSnapshot docx dispatch", () => {
  it("re-renders a custom-node snapshot to DOCX", async () => {
    const catalog = await Catalog.fromDir(customDir);
    const { snapshot } = await renderDocument({
      catalog, template: "doc", data: { title: "DOCX HI" }, customBlocks: bannerBlocks, format: "pdf", snapshotMode: "full",
    });

    const result = await renderFromSnapshot(snapshot, { customBlocks: bannerBlocks, format: "docx" });

    expect(result.format).toBe("docx");
    expect(await docXml(result.buffer)).toContain("DOCX HI");
  });

  it("re-assembles a pins snapshot to DOCX (the reassembly path)", async () => {
    const catalog = await Catalog.fromDir(customDir);
    const { snapshot } = await renderDocument({
      catalog, template: "doc", data: { title: "DOCX PINS" }, customBlocks: bannerBlocks, format: "pdf", snapshotMode: "pins",
    });
    expect(snapshot.tree).toBeUndefined();

    const result = await renderFromSnapshot(snapshot, { catalog, customBlocks: bannerBlocks, format: "docx" });

    expect(await docXml(result.buffer)).toContain("DOCX PINS");
  });
});
