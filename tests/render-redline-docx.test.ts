import { describe, expect, it } from "vitest";
import { Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import type { DocumentTree } from "../src/core/document-tree";
import { applyEdits } from "../src/core/edit/apply";
import type { Comment, EditOp } from "../src/core/edit/edit-set";
import { buildRedline, type RedlineDoc } from "../src/core/edit/redline-model";
import { parseTreePath as p } from "../src/core/edit/tree-path";
import type { CustomBlockRegistry } from "../src/custom-block";
import { renderTreeToDocx } from "../src/render-docx/render-docx";
import { renderRedlineToDocx } from "../src/render-docx/redline-docx";
import { allKindsTree } from "./fixtures/all-kinds-tree";

/**
 * The same Edit set the HTML redline golden uses (`render-redline-html.test.ts`), so the two Renderers
 * are asserted against one story: a reworded paragraph, rewritten rich text with marks, an article
 * heading, a key-value cell, a party field, a signature place, an inserted block, a deleted list item,
 * a moved node, an alignment override and a page-furniture slot.
 */
const ops: EditOp[] = [
  { op: "setText", path: p("/body/1/text"), value: "Entered into on 2 February 2026." },
  {
    op: "setRichText",
    path: p("/body/2/value"),
    value: {
      type: "doc",
      blocks: [{ type: "paragraph", runs: [{ text: "Plain " }, { text: "bold", marks: ["bold"] }, { text: " and rewritten." }] }],
    },
  },
  { op: "setText", path: p("/body/3/party/name"), value: "Acme Bank SE" },
  { op: "setText", path: p("/body/5/heading"), value: "Definitions and interpretation" },
  { op: "setStyle", path: p("/body/5/body/0/align"), value: "center" },
  { op: "setText", path: p("/body/8/rows/1/value"), value: "5.0 %" },
  { op: "setText", path: p("/body/11/places/1/role"), value: "Pledgor" },
  { op: "setFurniture", path: p("/header"), value: { left: "Pledge Agreement", center: "", right: "Internal" } },
  { op: "removeListItem", path: p("/body/6/items/1") },
  { op: "insertNode", path: p("/body/7"), node: { kind: "paragraph", text: "A brand new recital." } },
  { op: "moveNode", from: p("/body/5/body/1"), to: p("/body/5/body/2") },
];

/** Both fixture components have a DOCX implementation, so nothing degrades. */
const customBlocks: CustomBlockRegistry = {
  "qr-code": { docx: () => [new Paragraph({ children: [new TextRun("QR CODE")] })] },
  "page-break": { docx: () => [new Paragraph({ children: [new TextRun("PAGE BREAK")] })] },
};
const options = { customBlocks, degradation: "throw" } as const;

const AUTHOR = "Redline Bot";
const DATE = "2026-09-11T10:00:00Z";

/**
 * Comments in the EDITED tree: on the (unchanged) title, on the key-value table as a whole, one the
 * edit orphaned, and one on a `custom` block — the last two have nowhere to hang in Word.
 */
const comments: Comment[] = [
  {
    id: "c1",
    path: p("/body/0/text"),
    originalPath: p("/body/0/text"),
    anchoredAfterOp: 0,
    text: "Confirm the agreement title with counsel.",
    author: "Jane Reviewer",
    at: "2026-09-11T09:00:00.000Z",
  },
  { id: "c2", path: p("/body/9"), originalPath: p("/body/8"), anchoredAfterOp: 0, text: "Rate agreed by e-mail.", resolved: true },
  { id: "c3", path: null, originalPath: p("/body/6/items/1"), anchoredAfterOp: 0, text: "This bullet was dropped." },
  { id: "c4", path: p("/body/10"), originalPath: p("/body/10"), anchoredAfterOp: 0, text: "Regenerate the QR code." },
];

function editedTree(): DocumentTree {
  const edited = applyEdits(allKindsTree, ops);
  // A `custom` block is opaque to editing (ADR-0005), so no op can touch it — its props are changed
  // directly here. The redline must still report it, as a deletion plus an insertion.
  const custom = edited.body[10];
  if (custom?.kind !== "custom") throw new Error("fixture drift: /body/10 is no longer a custom block");
  custom.props = { value: "https://example.test/changed", size: 128 };
  return edited;
}

function redlineOf(base: DocumentTree, edited: DocumentTree): RedlineDoc {
  return buildRedline(base, edited);
}

/** One part of a .docx Buffer as a string. */
async function part(buffer: Buffer, name: string): Promise<string> {
  const file = (await JSZip.loadAsync(buffer)).file(name);
  if (!file) throw new Error(`no ${name} in the .docx`);
  return file.async("string");
}

/** The text of every `<w:ins>` / `<w:del>` element, so an assertion can say what was tracked. */
function tracked(xml: string, element: "w:ins" | "w:del"): string[] {
  const text = element === "w:ins" ? "w:t" : "w:delText";
  return [...xml.matchAll(new RegExp(`<${element}\\b[^>]*>([\\s\\S]*?)</${element}>`, "g"))].map((match) =>
    [...(match[1] ?? "").matchAll(new RegExp(`<${text}[^>]*>([\\s\\S]*?)</${text}>`, "g"))].map((run) => run[1]).join(""),
  );
}

describe("renderRedlineToDocx", () => {
  it("renders the plain document when nothing changed", async () => {
    const buffer = await renderRedlineToDocx(redlineOf(allKindsTree, structuredClone(allKindsTree)), { ...options, author: AUTHOR, date: DATE });

    const xml = await part(buffer, "word/document.xml");
    expect(xml).toBe(await part(await renderTreeToDocx(allKindsTree, options), "word/document.xml"));
    expect(xml).not.toContain("<w:ins ");
    expect(xml).not.toContain("<w:del ");
  });

  it("emits w:ins / w:del with the author and date for text, block and rich-text changes", async () => {
    const buffer = await renderRedlineToDocx(redlineOf(allKindsTree, editedTree()), { ...options, author: AUTHOR, date: DATE });
    const xml = await part(buffer, "word/document.xml");

    // Every tracked change is attributed.
    expect(xml).toMatch(/<w:ins [^>]*w:author="Redline Bot"[^>]*w:date="2026-09-11T10:00:00Z"/);
    expect(xml).toMatch(/<w:del [^>]*w:author="Redline Bot"[^>]*w:date="2026-09-11T10:00:00Z"/);
    // Deleted text is `w:delText`, never `w:t` — Word refuses the file otherwise.
    expect(xml).toContain("<w:delText");

    const inserted = tracked(xml, "w:ins");
    const deleted = tracked(xml, "w:del");
    // Word-level change inside a paragraph: only the words that moved are tracked.
    expect(inserted).toContain("2");
    expect(inserted).toContain("February");
    expect(deleted).toContain("1");
    expect(deleted).toContain("January");
    // Rich text, with its marks.
    expect(inserted).toContain("rewritten.");
    expect(deleted).toContain("italic");
    // A whole inserted block, and a whole deleted list item.
    expect(inserted).toContain("A brand new recital.");
    expect(deleted).toContain("• A titled bullet.");
    // Leaves inside own-layout nodes: a party field, a key-value cell, a signature role.
    expect(inserted).toContain("SE");
    expect(inserted).toContain("5.0");
    expect(inserted).toContain("Pledgor");
    // An article heading keeps its (non-editable) number outside the tracked run.
    expect(inserted).toContain(" and interpretation");
    // A `custom` block's DOCX is code-side, so a change to it is reported by a tracked marker.
    expect(deleted).toContain("[Custom block removed: qr-code]");
    expect(inserted).toContain("[Custom block added: qr-code]");
  });

  it("reports changed page furniture as a trailing section", async () => {
    const xml = await part(await renderRedlineToDocx(redlineOf(allKindsTree, editedTree()), { ...options, author: AUTHOR, date: DATE }), "word/document.xml");

    expect(xml).toContain("Page header and footer");
    expect(xml).toContain("/header/right");
    expect(tracked(xml, "w:ins")).toContain("Internal");
    expect(tracked(xml, "w:del")).toContain("Confidential");
  });

  it("tracks the paragraph mark of a whole inserted or deleted block", async () => {
    const xml = await part(await renderRedlineToDocx(redlineOf(allKindsTree, editedTree()), { ...options, author: AUTHOR, date: DATE }), "word/document.xml");

    // Without a tracked paragraph mark, accepting an insertion in Word leaves an empty paragraph.
    expect(xml).toMatch(/<w:pPr>(?:(?!<\/w:pPr>).)*<w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr>/);
    expect(xml).toMatch(/<w:pPr>(?:(?!<\/w:pPr>).)*<w:rPr><w:del [^>]*\/><\/w:rPr><\/w:pPr>/);
  });

  it("keeps the unchanged text of a changed block untracked", async () => {
    const xml = await part(await renderRedlineToDocx(redlineOf(allKindsTree, editedTree()), { ...options, author: AUTHOR, date: DATE }), "word/document.xml");

    const inserted = tracked(xml, "w:ins");
    expect(inserted).not.toContain("Entered into on ");
    expect(xml).toContain("Entered into on ");
  });

  it("carries comments into word/comments.xml, anchored in the document", async () => {
    const buffer = await renderRedlineToDocx(redlineOf(allKindsTree, editedTree()), { ...options, author: AUTHOR, date: DATE, comments });

    const xml = await part(buffer, "word/document.xml");
    const commentsXml = await part(buffer, "word/comments.xml");

    expect(commentsXml).toContain("Confirm the agreement title with counsel.");
    expect(commentsXml).toContain("Jane Reviewer");
    expect(commentsXml).toContain("Rate agreed by e-mail.");
    // An anchor is a range plus a reference, all three sharing one id.
    expect(xml).toMatch(/<w:commentRangeStart w:id="0"\s*\/>/);
    expect(xml).toMatch(/<w:commentRangeEnd w:id="0"\s*\/>/);
    expect(xml).toContain("w:commentReference");
    // The title comment surrounds the title, the table comment the table's first cell.
    expect(xml).toMatch(/<w:commentRangeStart w:id="0"\s*\/>[\s\S]*?PLEDGE AGREEMENT[\s\S]*?<w:commentRangeEnd w:id="0"\s*\/>/);
    expect(xml).toMatch(/<w:commentRangeStart w:id="1"\s*\/>[\s\S]*?Principal[\s\S]*?<w:commentRangeEnd w:id="1"\s*\/>/);
  });

  it("drops a comment Word has nowhere to hang", async () => {
    const buffer = await renderRedlineToDocx(redlineOf(allKindsTree, editedTree()), { ...options, author: AUTHOR, date: DATE, comments });

    const commentsXml = await part(buffer, "word/comments.xml");
    // Orphaned by the edit, so it has no path at all …
    expect(commentsXml).not.toContain("This bullet was dropped.");
    // … and a `custom` block is opaque (ADR-0005), so it contributes no text to anchor to.
    expect(commentsXml).not.toContain("Regenerate the QR code.");
  });

  it("rejects a redline mode it does not implement", async () => {
    await expect(
      // @ts-expect-error — "sideBySide" is reserved, not implemented.
      renderRedlineToDocx(redlineOf(allKindsTree, editedTree()), { ...options, mode: "sideBySide" }),
    ).rejects.toThrow(/only "inline" is implemented/);
  });
});
