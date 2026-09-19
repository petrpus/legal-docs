import { describe, it, expect } from "vitest";
import {
  createHtmlRenderContext,
  renderNodeToHtml,
  renderTreeToHtml,
} from "../src/render-html/render-html";
import type { CustomBlockRegistry } from "../src/custom-block";
import type { DocumentNode } from "../src/core/document-tree";
import { allKindsTree } from "./fixtures/all-kinds-tree";

const customBlocks: CustomBlockRegistry = {
  "qr-code": { html: () => `<img class="qr" alt="qr" />` },
  // no html impl → degrades to the placeholder, which must carry the path too
  "page-break": { pdf: () => null as never },
};

/** Render the all-kinds fixture with paths on, silencing the expected degradation warning. */
function renderWithPaths(): string {
  return renderTreeToHtml(allKindsTree, { customBlocks, emitPaths: true, onDegrade: () => {} });
}

/** Every `data-path` value the renderer emitted, in document order. */
function emittedPaths(html: string): string[] {
  return [...html.matchAll(/ data-path="([^"]*)"/g)].map((match) => match[1] ?? "");
}

describe("renderTreeToHtml with emitPaths", () => {
  it("addresses every block of the all-kinds tree, in document order", () => {
    expect(emittedPaths(renderWithPaths())).toEqual([
      "/body/0", // title
      "/body/1", // paragraph
      "/body/2", // richText container
      "/body/3", // partyHeader
      "/body/4", // partyHeader
      "/body/5", // article
      "/body/5/body/0", //   paragraph in the article body
      "/body/5/body/1", //   nested article
      "/body/5/body/1/body/0",
      "/body/5/body/2", //   numbered list in the article body
      "/body/5/body/2/items/0", //     list item
      "/body/5/body/2/items/0/0", //     paragraph in the item
      "/body/5/body/2/items/1",
      "/body/5/body/2/items/1/0", //     an article inside a list item
      "/body/5/body/2/items/1/0/body/0",
      "/body/6", // bullet list
      "/body/6/items/0",
      "/body/6/items/0/0",
      "/body/6/items/1",
      "/body/6/items/1/0",
      "/body/7", // alpha list
      "/body/7/items/0",
      "/body/7/items/0/0",
      "/body/8", // keyValueTable
      "/body/9", // custom (rendered)
      "/body/10", // custom (degraded placeholder)
      "/body/11", // signatures
    ]);
  });

  it("puts each path on the block's own element", () => {
    const html = renderWithPaths();

    expect(html).toContain('<h1 class="title" style="text-align:center" data-path="/body/0">');
    expect(html).toContain('<div class="rich" data-path="/body/2">');
    expect(html).toContain('<div class="party" data-path="/body/3">');
    expect(html).toContain('<section class="article" data-level="1" data-path="/body/5">');
    expect(html).toContain('<ol class="list" data-path="/body/5/body/2">');
    expect(html).toContain('<li data-path="/body/5/body/2/items/0">');
    expect(html).toContain('<ul class="list" data-path="/body/6">');
    expect(html).toContain('<ol class="list list--alpha" data-path="/body/7">');
    expect(html).toContain('<table class="kv" data-path="/body/8">');
    expect(html).toContain('<div class="signatures" data-path="/body/11">');
  });

  it("wraps a Custom block's own markup rather than injecting into it, and marks the placeholder", () => {
    const html = renderWithPaths();

    expect(html).toContain('<div data-path="/body/9"><img class="qr" alt="qr" /></div>');
    expect(html).toContain('<div class="legal-doc__unsupported" data-path="/body/10">');
  });

  it("leaves the default output untouched (no data-path anywhere)", () => {
    const off = renderTreeToHtml(allKindsTree, { customBlocks, onDegrade: () => {} });

    expect(off).not.toContain("data-path");
    expect(renderTreeToHtml(allKindsTree, { customBlocks, emitPaths: false, onDegrade: () => {} })).toBe(off);
  });

  it("escapes the attribute value", () => {
    const node: DocumentNode = { kind: "paragraph", text: "x" };

    const html = renderNodeToHtml(node, createHtmlRenderContext({ emitPaths: true }), ['body"><script']);

    expect(html).toBe('<p data-path="/body&quot;&gt;&lt;script">x</p>');
  });
});

describe("renderNodeToHtml", () => {
  it("renders one node exactly as the whole-tree render does", () => {
    const cx = createHtmlRenderContext({ customBlocks, emitPaths: true, onDegrade: () => {} });
    const article = allKindsTree.body[5] as DocumentNode;

    expect(renderWithPaths()).toContain(renderNodeToHtml(article, cx, ["body", 5]));
  });

  it("emits no path when the context does not ask for one", () => {
    expect(renderNodeToHtml({ kind: "paragraph", text: "x" }, createHtmlRenderContext(), ["body", 0])).toBe("<p>x</p>");
  });
});
