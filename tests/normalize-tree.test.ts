import { describe, it, expect } from "vitest";
import { normalizeRichText, normalizeTree } from "../src/edit/normalize";
import type { DocumentTree } from "../src/core/document-tree";
import { allKindsTree } from "./fixtures/all-kinds-tree";

/**
 * `normalizeTree` is the canonical form a WYSIWYG editor round-trips through (#158): everything a
 * ProseMirror document cannot express twice — an empty text node, adjacent runs carrying the same
 * marks, a mark order, a style key explicitly set to `undefined` — is collapsed here, so the mapping
 * into the editor and back is an identity on normal trees.
 */

function tree(body: DocumentTree["body"]): DocumentTree {
  return { body };
}

describe("normalizeTree — rich text", () => {
  it("coalesces adjacent runs carrying the same marks", () => {
    const normalized = normalizeRichText({
      type: "doc",
      blocks: [
        {
          type: "paragraph",
          runs: [
            { text: "one " },
            { text: "two" },
            { text: "bold", marks: ["bold"] },
            { text: "er", marks: ["bold"] },
            { text: " tail" },
          ],
        },
      ],
    });

    expect(normalized.blocks[0]?.runs).toStrictEqual([
      { text: "one two" },
      { text: "bolder", marks: ["bold"] },
      { text: " tail" },
    ]);
  });

  it("puts marks in canonical order, de-duplicates them and drops an empty mark list", () => {
    const normalized = normalizeRichText({
      type: "doc",
      blocks: [
        {
          type: "paragraph",
          runs: [
            { text: "a", marks: ["italic", "bold"] },
            { text: "b", marks: ["bold", "italic"] },
            { text: "c", marks: ["bold", "bold"] },
            { text: "d", marks: [] },
          ],
        },
      ],
    });

    expect(normalized.blocks[0]?.runs).toStrictEqual([
      { text: "ab", marks: ["bold", "italic"] },
      { text: "c", marks: ["bold"] },
      { text: "d" },
    ]);
  });

  it("drops empty runs but keeps a single empty run for an empty paragraph", () => {
    const normalized = normalizeRichText({
      type: "doc",
      blocks: [
        { type: "paragraph", runs: [{ text: "a" }, { text: "", marks: ["bold"] }, { text: "b" }] },
        { type: "paragraph", runs: [] },
        { type: "paragraph", runs: [{ text: "", marks: ["italic"] }] },
      ],
    });

    expect(normalized.blocks).toStrictEqual([
      { type: "paragraph", runs: [{ text: "ab" }] },
      { type: "paragraph", runs: [{ text: "" }] },
      { type: "paragraph", runs: [{ text: "" }] },
    ]);
  });

  it("keeps a single empty paragraph for a rich text with no blocks", () => {
    expect(normalizeRichText({ type: "doc", blocks: [] })).toStrictEqual({
      type: "doc",
      blocks: [{ type: "paragraph", runs: [{ text: "" }] }],
    });
  });
});

describe("normalizeTree — style keys", () => {
  it("omits a style key whose value is undefined", () => {
    const normalized = normalizeTree(
      tree([
        { kind: "title", text: "T", align: undefined, indent: undefined },
        { kind: "paragraph", text: "P", indent: {} },
        { kind: "paragraph", text: "Q", indent: { firstLine: undefined, left: undefined } },
      ]),
    );

    expect(normalized.body).toStrictEqual([
      { kind: "title", text: "T" },
      { kind: "paragraph", text: "P" },
      { kind: "paragraph", text: "Q" },
    ]);
  });

  it("keeps the style keys that are set, including a zero indent", () => {
    const normalized = normalizeTree(
      tree([{ kind: "paragraph", text: "P", align: "justify", indent: { left: 0, firstLine: undefined } }]),
    );

    expect(normalized.body).toStrictEqual([{ kind: "paragraph", text: "P", align: "justify", indent: { left: 0 } }]);
  });

  it("omits the undefined optional fields of an article, a party and a signature place", () => {
    const normalized = normalizeTree(
      tree([
        { kind: "article", no: "1", level: 1, heading: undefined, body: [] },
        { kind: "partyHeader", party: { name: "Jane", kind: undefined, idNumber: undefined }, roleLabel: "Buyer" },
        { kind: "signatures", places: [{ name: "Jane", role: undefined }] },
      ]),
    );

    expect(normalized.body).toStrictEqual([
      { kind: "article", no: "1", level: 1, body: [] },
      { kind: "partyHeader", party: { name: "Jane" }, roleLabel: "Buyer" },
      { kind: "signatures", places: [{ name: "Jane" }] },
    ]);
  });
});

describe("normalizeTree — structure", () => {
  it("recurses into article bodies and list items", () => {
    const normalized = normalizeTree(
      tree([
        {
          kind: "article",
          no: "1",
          level: 1,
          body: [
            {
              kind: "numberedList",
              items: [[{ kind: "paragraph", text: "item", align: undefined }], []],
            },
          ],
        },
      ]),
    );

    expect(normalized.body).toStrictEqual([
      {
        kind: "article",
        no: "1",
        level: 1,
        body: [{ kind: "numberedList", items: [[{ kind: "paragraph", text: "item" }], []] }],
      },
    ]);
  });

  it("leaves a custom block's props opaque — same value, and the key survives when undefined", () => {
    const props = { nested: { deep: [1, 2] } };
    const normalized = normalizeTree(
      tree([
        { kind: "custom", component: "qr-code", props },
        { kind: "custom", component: "page-break", props: undefined },
      ]),
    );

    expect(normalized.body[0]).toStrictEqual({ kind: "custom", component: "qr-code", props });
    expect((normalized.body[0] as { props: unknown }).props).toBe(props);
    expect(normalized.body[1]).toStrictEqual({ kind: "custom", component: "page-break", props: undefined });
    expect(Object.hasOwn(normalized.body[1] as object, "props")).toBe(true);
  });

  it("carries header, footer and page through untouched, omitting the absent ones", () => {
    const withFurniture = normalizeTree({ body: [], header: { left: "H" }, page: { size: "A4" } });
    expect(withFurniture).toStrictEqual({ body: [], header: { left: "H" }, page: { size: "A4" } });
    expect(normalizeTree({ body: [] })).toStrictEqual({ body: [] });
  });
});

describe("normalizeTree — algebra", () => {
  it("leaves an already-normal tree deep-equal to itself", () => {
    expect(normalizeTree(allKindsTree)).toStrictEqual(allKindsTree);
  });

  it("is idempotent", () => {
    const once = normalizeTree(allKindsTree);
    expect(normalizeTree(once)).toStrictEqual(once);

    const messy: DocumentTree = {
      body: [
        { kind: "title", text: "T", align: undefined },
        {
          kind: "richText",
          value: {
            type: "doc",
            blocks: [{ type: "paragraph", runs: [{ text: "a", marks: [] }, { text: "b" }, { text: "" }] }],
          },
        },
      ],
    };
    const first = normalizeTree(messy);
    expect(normalizeTree(first)).toStrictEqual(first);
  });

  it("never mutates its input", () => {
    const input: DocumentTree = {
      body: [
        {
          kind: "richText",
          value: { type: "doc", blocks: [{ type: "paragraph", runs: [{ text: "a" }, { text: "b" }] }] },
        },
      ],
    };
    const before = structuredClone(input);
    normalizeTree(input);
    expect(input).toStrictEqual(before);
  });
});
