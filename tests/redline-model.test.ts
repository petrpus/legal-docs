import { describe, expect, it } from "vitest";
import type { DocumentTree } from "../src/core/document-tree";
import { applyEdits } from "../src/core/edit/apply";
import type { EditOp } from "../src/core/edit/edit-set";
import { buildRedline, type RedlineBlock } from "../src/core/edit/redline-model";
import { allKindsTree } from "./fixtures/all-kinds-tree";

function redlineOf(...ops: EditOp[]) {
  return buildRedline(allKindsTree, applyEdits(allKindsTree, ops));
}

/** The `container` block at `/body/5` (the "Definitions" article) — the nesting most tests reach into. */
function articleBlock(blocks: readonly RedlineBlock[]): Extract<RedlineBlock, { status: "container" }> {
  const block = blocks.find((candidate) => candidate.node.kind === "article");
  if (block?.status !== "container") throw new Error("expected the article to be a container block");
  return block;
}

describe("buildRedline", () => {
  it("maps identical trees to unchanged blocks only", () => {
    const doc = buildRedline(allKindsTree, structuredClone(allKindsTree));
    expect(doc.blocks).toHaveLength(allKindsTree.body.length);
    expect(doc.blocks.every((block) => block.status === "unchanged")).toBe(true);
    expect(doc.furniture).toEqual([]);
    expect(doc.stats).toEqual({
      unchanged: allKindsTree.body.length,
      inserted: 0,
      deleted: 0,
      textChanged: 0,
      attrsChanged: 0,
      container: 0,
      changed: 0,
    });
  });

  it("keeps a reference to both trees it was built from", () => {
    const edited = applyEdits(allKindsTree, []);
    const doc = buildRedline(allKindsTree, edited);
    expect(doc.base).toBe(allKindsTree);
    expect(doc.edited).toBe(edited);
  });

  it("diffs a changed string leaf word by word", () => {
    const doc = redlineOf({ op: "setText", path: ["body", 0, "text"], value: "PLEDGE AGREEMENT (AMENDED)" });
    const block = doc.blocks[0];
    expect(block?.status).toBe("textChanged");
    if (block?.status !== "textChanged") throw new Error("unreachable");
    expect(block.path).toEqual(["body", 0]);
    expect(block.node).toEqual({ kind: "title", text: "PLEDGE AGREEMENT (AMENDED)", align: "center" });
    expect(block.fields).toEqual([
      {
        kind: "text",
        path: ["body", 0, "text"],
        before: "PLEDGE AGREEMENT",
        after: "PLEDGE AGREEMENT (AMENDED)",
        segments: [
          { op: "equal", text: "PLEDGE AGREEMENT" },
          { op: "ins", text: " (AMENDED)" },
        ],
      },
    ]);
    expect(doc.stats).toEqual({
      unchanged: allKindsTree.body.length - 1,
      inserted: 0,
      deleted: 0,
      textChanged: 1,
      attrsChanged: 0,
      container: 0,
      changed: 1,
    });
  });

  it("diffs rich text per paragraph, taking marks from the after side on equal/ins and the before side on del", () => {
    const doc = redlineOf({
      op: "setRichText",
      path: ["body", 2, "value"],
      value: {
        type: "doc",
        blocks: [
          {
            type: "paragraph",
            runs: [
              { text: "Plain " },
              { text: "strong", marks: ["bold"] },
              { text: " and " },
              { text: "italic", marks: ["italic"] },
            ],
          },
        ],
      },
    });
    const block = doc.blocks[2];
    if (block?.status !== "textChanged") throw new Error("expected the richText node to be textChanged");
    const [field] = block.fields;
    if (field?.kind !== "richText") throw new Error("expected a richText field");
    expect(field.path).toEqual(["body", 2, "value"]);
    expect(field.paragraphs).toEqual([
      {
        status: "changed",
        runs: [
          { text: "Plain ", op: "equal" },
          { text: "bold", marks: ["bold"], op: "del" },
          { text: "strong", marks: ["bold"], op: "ins" },
          { text: " and ", op: "equal" },
          { text: "italic", marks: ["italic"], op: "equal" },
        ],
      },
    ]);
  });

  it("marks a whole added rich-text paragraph as inserted and a dropped one as deleted", () => {
    const doc = redlineOf({
      op: "setRichText",
      path: ["body", 2, "value"],
      value: {
        type: "doc",
        blocks: [
          { type: "paragraph", runs: [{ text: "A wholly new paragraph." }] },
          {
            type: "paragraph",
            runs: [
              { text: "Plain " },
              { text: "bold", marks: ["bold"] },
              { text: " and " },
              { text: "italic", marks: ["italic"] },
            ],
          },
        ],
      },
    });
    const block = doc.blocks[2];
    if (block?.status !== "textChanged") throw new Error("expected the richText node to be textChanged");
    const [field] = block.fields;
    if (field?.kind !== "richText") throw new Error("expected a richText field");
    expect(field.paragraphs.map((paragraph) => paragraph.status)).toEqual(["inserted", "unchanged"]);
    expect(field.paragraphs[0]?.runs).toEqual([{ text: "A wholly new paragraph.", op: "ins" }]);
  });

  it("reports a style-only change as attrsChanged", () => {
    const doc = redlineOf({ op: "setStyle", path: ["body", 1, "align"], value: "center" });
    const block = doc.blocks[1];
    if (block?.status !== "attrsChanged") throw new Error("expected an attrsChanged block");
    expect(block.attrs).toEqual([{ path: ["body", 1, "align"], before: undefined, after: "center" }]);
    expect(doc.stats.attrsChanged).toBe(1);
  });

  it("marks an inserted node as inserted and leaves every other block alone", () => {
    const node = { kind: "paragraph", text: "A brand new recital." } as const;
    const doc = redlineOf({ op: "insertNode", path: ["body", 1], node });
    expect(doc.blocks[1]).toEqual({ status: "inserted", path: ["body", 1], node });
    expect(doc.stats.inserted).toBe(1);
    expect(doc.stats.unchanged).toBe(allKindsTree.body.length);
  });

  it("keeps a removed node in the redline as a deleted block at its base path", () => {
    const doc = redlineOf({ op: "removeNode", path: ["body", 1] });
    expect(doc.blocks[1]).toEqual({ status: "deleted", path: ["body", 1], node: allKindsTree.body[1] });
    expect(doc.blocks).toHaveLength(allKindsTree.body.length);
    expect(doc.stats.deleted).toBe(1);
  });

  it("recurses into an article body as a container block", () => {
    const doc = redlineOf({ op: "setText", path: ["body", 5, "body", 0, "text"], value: "Rewritten." });
    const block = articleBlock(doc.blocks);
    expect(block.path).toEqual(["body", 5]);
    expect(block.fields).toEqual([]);
    expect(block.children.of).toBe("body");
    if (block.children.of !== "body") throw new Error("unreachable");
    expect(block.children.blocks.map((child) => child.status)).toEqual(["textChanged", "unchanged", "unchanged"]);
    expect(doc.stats).toEqual({
      unchanged: allKindsTree.body.length - 1 + 2,
      inserted: 0,
      deleted: 0,
      textChanged: 1,
      attrsChanged: 0,
      container: 1,
      changed: 1,
    });
  });

  it("carries an article heading change on the container block itself", () => {
    const doc = redlineOf({ op: "setText", path: ["body", 5, "heading"], value: "Definitions and interpretation" });
    const block = articleBlock(doc.blocks);
    expect(block.fields).toEqual([
      {
        kind: "text",
        path: ["body", 5, "heading"],
        before: "Definitions",
        after: "Definitions and interpretation",
        segments: [
          { op: "equal", text: "Definitions" },
          { op: "ins", text: " and interpretation" },
        ],
      },
    ]);
  });

  it("recurses into list items, marking an inserted item and its blocks", () => {
    const doc = redlineOf({
      op: "insertListItem",
      path: ["body", 5, "body", 2, "items", 1],
      item: [{ kind: "paragraph", text: "An inserted numbered item." }],
    });
    const list = articleBlock(doc.blocks).children;
    if (list.of !== "body") throw new Error("unreachable");
    const listBlock = list.blocks[2];
    if (listBlock?.status !== "container" || listBlock.children.of !== "items") {
      throw new Error("expected the numbered list to be a container of items");
    }
    expect(listBlock.children.items.map((item) => item.status)).toEqual(["unchanged", "inserted", "unchanged"]);
    expect(listBlock.children.items.map((item) => item.path)).toEqual([
      ["body", 5, "body", 2, "items", 0],
      ["body", 5, "body", 2, "items", 1],
      ["body", 5, "body", 2, "items", 2],
    ]);
    expect(listBlock.children.items[1]?.blocks).toEqual([
      {
        status: "inserted",
        path: ["body", 5, "body", 2, "items", 1, 0],
        node: { kind: "paragraph", text: "An inserted numbered item." },
      },
    ]);
  });

  it("replaces a changed custom block wholesale", () => {
    const edited = structuredClone(allKindsTree) as DocumentTree;
    const custom = edited.body[9];
    if (custom?.kind !== "custom") throw new Error("fixture drift: /body/9 is no longer a custom block");
    custom.props = { value: "https://example.test/changed", size: 96 };
    const doc = buildRedline(allKindsTree, edited);
    expect(doc.blocks.slice(9, 11).map((block) => block.status)).toEqual(["deleted", "inserted"]);
  });

  it("diffs page furniture slot by slot", () => {
    const doc = redlineOf({
      op: "setFurniture",
      path: ["header"],
      value: { left: "Pledge Agreement", center: "", right: "Internal" },
    });
    expect(doc.furniture).toEqual([
      {
        kind: "text",
        path: ["header", "right"],
        before: "Confidential",
        after: "Internal",
        segments: [
          { op: "del", text: "Confidential" },
          { op: "ins", text: "Internal" },
        ],
      },
    ]);
  });
});
