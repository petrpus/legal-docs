import type { DocumentTree } from "../../src/core/document-tree";

/**
 * A DocumentTree exercising every Core node kind at least once, plus the structural nesting the
 * renderers have to survive: articles inside articles, a list item containing an article, a `custom`
 * node with and without props, page furniture and a page-geometry override.
 *
 * Shared by the schema tests and (later slices) the edit/round-trip suites, so "all kinds" has a
 * single definition rather than one ad-hoc tree per test file.
 */
export const allKindsTree: DocumentTree = {
  body: [
    { kind: "title", text: "PLEDGE AGREEMENT", align: "center" },
    { kind: "paragraph", text: "Entered into on 1 January 2026.", indent: { firstLine: 12, left: 0 } },
    {
      kind: "richText",
      value: {
        type: "doc",
        blocks: [
          { type: "paragraph", runs: [{ text: "Plain " }, { text: "bold", marks: ["bold"] }, { text: " and " }, { text: "italic", marks: ["italic"] }] },
        ],
      },
    },
    { kind: "partyHeader", party: { name: "Acme Bank a.s.", kind: "company", idNumber: "12345678", address: "Prague" }, roleLabel: "Pledgee" },
    { kind: "partyHeader", party: { name: "Jane Doe" }, roleLabel: "Pledgor" },
    {
      kind: "article",
      no: "1",
      level: 1,
      heading: "Definitions",
      body: [
        { kind: "paragraph", text: "Capitalised terms have the meanings given below.", align: "justify" },
        {
          kind: "article",
          no: "1.1",
          level: 2,
          body: [{ kind: "paragraph", text: "A nested article with no heading." }],
        },
        {
          kind: "numberedList",
          items: [
            [{ kind: "paragraph", text: "First numbered item." }],
            // A list item carrying a whole article — the deepest nesting the renderers accept.
            [
              {
                kind: "article",
                no: "1.2",
                level: 2,
                heading: "Article inside a list item",
                body: [{ kind: "paragraph", text: "Nested body." }],
              },
            ],
          ],
        },
      ],
    },
    { kind: "bulletList", items: [[{ kind: "paragraph", text: "A bullet." }], [{ kind: "title", text: "A titled bullet." }]] },
    { kind: "alphaList", items: [[{ kind: "paragraph", text: "Item (a)." }]] },
    { kind: "keyValueTable", rows: [{ label: "Principal", value: "1 000 000 CZK" }, { label: "Rate", value: "4.5 %" }] },
    { kind: "custom", component: "qr-code", props: { value: "https://example.test", size: 96 } },
    // `props` is opaque (ADR-0005) — a component that takes none still validates.
    { kind: "custom", component: "page-break", props: undefined },
    { kind: "signatures", places: [{ name: "Acme Bank a.s.", role: "Pledgee" }, { name: "Jane Doe" }] },
  ],
  header: { left: "Pledge Agreement", center: "", right: "Confidential" },
  footer: { center: "Page 1" },
  page: { size: "A4", orientation: "portrait" },
};
