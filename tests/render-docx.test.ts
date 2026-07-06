import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { Text } from "@react-pdf/renderer";
import { Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { renderTreeToDocx } from "../src/render-docx/render-docx";
import { parseRichText } from "../src/core/rich-text";
import { defaultTheme } from "../src/theme";
import type { DocumentTree } from "../src/core/document-tree";
import type { CustomBlockRegistry } from "../src/custom-block";

/** The raw word/document.xml of a .docx Buffer (text lives in <w:t> nodes). */
async function docXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("no word/document.xml in the .docx");
  return file.async("string");
}

const tree: DocumentTree = [
  { kind: "title", text: "PLEDGE AGREEMENT" },
  { kind: "paragraph", text: "A plain paragraph." },
  { kind: "richText", value: parseRichText("This is **bold** text.") },
  {
    kind: "article",
    no: "1.",
    level: 1,
    heading: "Definitions",
    body: [{ kind: "paragraph", text: "Nested body line." }],
  },
  { kind: "numberedList", items: [[{ kind: "paragraph", text: "first item" }]] },
  { kind: "partyHeader", party: { name: "Acme Bank a.s.", idNumber: "12345678" }, roleLabel: "Lender" },
  { kind: "keyValueTable", rows: [{ label: "Principal", value: "EUR 250000" }] },
  { kind: "signatures", places: [{ name: "Jane Doe", role: "Borrower" }] },
];

const customBlocks: CustomBlockRegistry = {
  box: {
    pdf: () => createElement(Text, null, "x"),
    docx: () => [new Paragraph({ children: [new TextRun("CUSTOM DOCX CONTENT")] })],
  },
  pdfOnly: { pdf: () => createElement(Text, null, "x") }, // no docx → degrades
};

describe("renderTreeToDocx", () => {
  it("produces a valid .docx with every core node's text", async () => {
    const buffer = await renderTreeToDocx(tree);

    expect(buffer.length).toBeGreaterThan(500);
    expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK"); // zip magic
    const xml = await docXml(buffer);
    for (const text of [
      "PLEDGE AGREEMENT",
      "A plain paragraph.",
      "bold",
      "Definitions",
      "1. first item",
      "Acme Bank a.s.",
      "Lender",
      "Principal",
      "EUR 250000",
      "Jane Doe",
      "Borrower",
    ]) {
      expect(xml, `missing "${text}"`).toContain(text);
    }
  });

  it("indents a nested article body by indentPerLevel twips", async () => {
    const xml = await docXml(await renderTreeToDocx(tree));

    expect(xml).toContain('w:left="280"'); // indentPerLevel 14pt → twips = 280
  });

  it("renders bold and italic as run properties", async () => {
    const xml = await docXml(
      await renderTreeToDocx([{ kind: "richText", value: parseRichText("**b** and *i*") }]),
    );

    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("<w:i/>");
  });

  it("renders bullet/alpha markers, party address, a role-less signature, and an empty tree", async () => {
    const xml = await docXml(
      await renderTreeToDocx([
        { kind: "bulletList", items: [[{ kind: "paragraph", text: "b" }]] },
        { kind: "alphaList", items: [[{ kind: "paragraph", text: "a" }]] },
        { kind: "partyHeader", party: { name: "P", address: "1 St" }, roleLabel: "R" },
        { kind: "signatures", places: [{ name: "Solo" }] },
      ]),
    );
    expect(xml).toContain("• b");
    expect(xml).toContain("a. a");
    expect(xml).toContain("1 St");
    expect(xml).toContain("Solo");

    const empty = await renderTreeToDocx([]);
    expect(empty.length).toBeGreaterThan(300);
    expect(empty.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("renders (never silently drops) a custom block inside a list item — degradation still fires", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const degraded = await docXml(
      await renderTreeToDocx(
        [{ kind: "numberedList", items: [[{ kind: "custom", component: "pdfOnly", props: undefined }]] }],
        { theme: defaultTheme, customBlocks },
      ),
    );
    expect(degraded).toContain("[unsupported block: pdfOnly in docx]");
    warn.mockRestore();

    const rendered = await docXml(
      await renderTreeToDocx(
        [{ kind: "bulletList", items: [[{ kind: "custom", component: "box", props: undefined }]] }],
        { theme: defaultTheme, customBlocks },
      ),
    );
    expect(rendered).toContain("CUSTOM DOCX CONTENT");
  });

  it("renders a registered custom block's docx output", async () => {
    const xml = await docXml(
      await renderTreeToDocx([{ kind: "custom", component: "box", props: undefined }], { theme: defaultTheme, customBlocks }),
    );

    expect(xml).toContain("CUSTOM DOCX CONTENT");
  });

  it("fails fast on an unregistered component", async () => {
    await expect(
      renderTreeToDocx([{ kind: "custom", component: "ghost", props: undefined }]),
    ).rejects.toThrow(/Custom block "ghost" is not registered/);
  });

  it("degrades a block missing its docx impl to a visible, logged placeholder", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const xml = await docXml(
      await renderTreeToDocx([{ kind: "custom", component: "pdfOnly", props: undefined }], { theme: defaultTheme, customBlocks }),
    );

    expect(xml).toContain("[unsupported block: pdfOnly in docx]");
    expect(warn).toHaveBeenCalledWith("[unsupported block: pdfOnly in docx]");
    warn.mockRestore();
  });

  it("fails hard for a missing docx impl in throw mode", async () => {
    await expect(
      renderTreeToDocx([{ kind: "custom", component: "pdfOnly", props: undefined }], { theme: defaultTheme, customBlocks, degradation: "throw" }),
    ).rejects.toThrow(/Custom block "pdfOnly" cannot render in "docx"/);
  });
});
