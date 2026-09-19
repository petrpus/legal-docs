import { describe, it, expect, beforeAll } from "vitest";
import JSZip from "jszip";
import { PDFParse } from "pdf-parse";
import { createElement } from "react";
import { Text } from "@react-pdf/renderer";
import { Paragraph } from "docx";
import { allKindsTree } from "./fixtures/all-kinds-tree";
import { applyEdits } from "../src/core/edit/apply";
import { EDIT_OP_KINDS, type EditOp } from "../src/core/edit/edit-set";
import { parseTreePath as p } from "../src/core/edit/tree-path";
import { assertValidTree } from "../src/core/document-tree-schema";
import { renderTree } from "../src/facade/render-tree";
import type { DocumentTree } from "../src/core/document-tree";
import type { CustomBlockRegistry, RenderTreeOptions } from "../src/custom-block";

/**
 * The tracer bullet for the op set: ONE compound Edit set exercising every op kind against the
 * all-kinds fixture, then all three renderers over the result. The per-op unit tests pin semantics;
 * this pins the thing that actually matters downstream — an edited tree is still a tree every
 * renderer accepts, including after nodes were inserted, removed and moved under it.
 */

const TITLE = "AMENDED PLEDGE AGREEMENT";
const RICH = "Rewritten rich text.";
const APPENDED = "Appended paragraph.";

/**
 * Applied in order, each op reading the tree the previous one left. The leaf edits come first so the
 * structural ops at the end can be read against the fixture's own indices.
 */
const ops: EditOp[] = [
  { op: "setText", path: p("/body/0/text"), value: TITLE },
  { op: "setRichText", path: p("/body/2/value"), value: { type: "doc", blocks: [{ type: "paragraph", runs: [{ text: RICH, marks: ["bold"] }] }] } },
  { op: "setStyle", path: p("/body/1/indent"), value: { left: 24 } },
  { op: "setFurniture", path: p("/footer"), value: { center: "Amended", right: "Draft" } },
  // The bullet list at `/body/6` gains an item and loses its original first one.
  { op: "insertListItem", path: p("/body/6/items/1"), item: [{ kind: "paragraph", text: "An inserted bullet." }] },
  { op: "removeListItem", path: p("/body/6/items/0") },
  { op: "replaceNode", path: p("/body/4"), node: { kind: "keyValueTable", rows: [{ label: "Replaced", value: "node" }] } },
  // `/body/10` is the propless `custom` block — removal and moving are kind-agnostic.
  { op: "removeNode", path: p("/body/10") },
  // The body is 11 nodes now, so index 11 appends.
  { op: "insertNode", path: p("/body/11"), node: { kind: "paragraph", text: APPENDED } },
  { op: "moveNode", from: p("/body/0"), to: p("/body/2") },
];

/** The fixture's surviving `custom` block. Registered in all three formats so nothing degrades here. */
const customBlocks: CustomBlockRegistry = {
  "qr-code": {
    pdf: () => createElement(Text, null, "QR"),
    html: () => "<span>QR</span>",
    docx: () => [new Paragraph("QR")],
  },
};
const options: RenderTreeOptions = { customBlocks, degradation: "throw" };

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    return (await parser.getText()).text.replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

describe("a compound edit using every op kind", () => {
  let edited: DocumentTree;

  beforeAll(() => {
    edited = applyEdits(allKindsTree, ops);
  });

  it("covers the whole op set", () => {
    expect(new Set(ops.map((op) => op.op))).toEqual(new Set(EDIT_OP_KINDS));
  });

  it("yields a valid tree carrying every change", () => {
    expect(() => assertValidTree(edited)).not.toThrow();
    expect(edited.body).toHaveLength(allKindsTree.body.length);
    // The title was moved to `/body/2` by the last op.
    expect(edited.body[2]).toMatchObject({ kind: "title", text: TITLE });
    expect(edited.body[11]).toMatchObject({ kind: "paragraph", text: APPENDED });
    expect(edited.footer).toEqual({ center: "Amended", right: "Draft" });
    expect(allKindsTree.body[0]).toMatchObject({ kind: "title", text: "PLEDGE AGREEMENT" });
  });

  it("renders to HTML", async () => {
    const out = await renderTree(edited, "html", options);
    if (out.format !== "html") throw new Error("expected html");
    expect(out.html).toContain(TITLE);
    expect(out.html).toContain(RICH);
    expect(out.html).toContain(APPENDED);
    expect(out.html).not.toContain("A bullet.");
  });

  it("renders to PDF", async () => {
    const out = await renderTree(edited, "pdf", options);
    if (out.format !== "pdf") throw new Error("expected pdf");
    expect(await pdfText(out.buffer)).toContain(TITLE);
  });

  it("renders to DOCX", async () => {
    const out = await renderTree(edited, "docx", options);
    if (out.format !== "docx") throw new Error("expected docx");
    const zip = await JSZip.loadAsync(out.buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain(TITLE);
    expect(xml).toContain(APPENDED);
  });
});
