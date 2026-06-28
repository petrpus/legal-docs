import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { Text } from "@react-pdf/renderer";
import { z } from "zod";
import { renderTreeToHtml } from "../src/render-html/render-html";
import { escapeHtml } from "../src/render-html/escape";
import { parseRichText } from "../src/core/rich-text";
import { defaultTheme } from "../src/render-pdf/theme";
import type { DocumentTree } from "../src/core/document-tree";
import type { CustomBlockRegistry } from "../src/render-pdf/custom-block";

const strictSchema = z.object({ label: z.string() });

const tree: DocumentTree = [
  { kind: "title", text: "AGREEMENT & TERMS" },
  { kind: "paragraph", text: "Plain <world> text" },
  { kind: "richText", value: parseRichText("This is **bold** and *italic*.") },
  { kind: "article", no: "1.", level: 1, heading: "Definitions", body: [{ kind: "paragraph", text: "Body." }] },
  {
    kind: "numberedList",
    items: [[{ kind: "paragraph", text: "first" }], [{ kind: "paragraph", text: "second" }]],
  },
  { kind: "partyHeader", party: { name: "Acme & Co", idNumber: "123" }, roleLabel: "Lender" },
  { kind: "keyValueTable", rows: [{ label: "Amount", value: "EUR 100" }] },
  { kind: "signatures", places: [{ name: "Jane Doe", role: "Borrower" }] },
];

const customBlocks: CustomBlockRegistry = {
  box: {
    pdf: () => createElement(Text, null, "box"),
    html: () => `<aside class="box">CUSTOM HTML</aside>`,
  },
  pdfOnly: { pdf: () => createElement(Text, null, "x") }, // no html → degrades
  strict: {
    schema: strictSchema,
    pdf: () => createElement(Text, null, "x"),
    html: (props) => `<b>${escapeHtml(strictSchema.parse(props).label)}</b>`,
  },
};

describe("renderTreeToHtml", () => {
  it("renders a self-contained fragment with a scoped style block (golden)", () => {
    const html = renderTreeToHtml(tree);

    expect(html.startsWith('<div class="legal-doc"><style>')).toBe(true);
    expect(html).toMatchSnapshot();
  });

  it("escapes all payload-derived text", () => {
    const html = renderTreeToHtml(tree);

    expect(html).toContain("AGREEMENT &amp; TERMS");
    expect(html).toContain("Plain &lt;world&gt; text");
    expect(html).toContain("Acme &amp; Co");
    expect(html).not.toContain("<world>");
  });

  it("renders rich-text marks as semantic elements", () => {
    const html = renderTreeToHtml(tree);

    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("neutralizes a script-injection payload in the document text", () => {
    const html = renderTreeToHtml([{ kind: "paragraph", text: "<script>alert(1)</script>" }]);

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("inserts a registered Custom block's html raw", () => {
    const html = renderTreeToHtml([{ kind: "custom", component: "box", props: undefined }], defaultTheme, customBlocks);

    expect(html).toContain('<aside class="box">CUSTOM HTML</aside>');
  });

  it("fails fast on an unregistered component", () => {
    expect(() => renderTreeToHtml([{ kind: "custom", component: "ghost", props: undefined }])).toThrow(
      /Custom block "ghost" is not registered/,
    );
  });

  it("degrades a block missing its html impl to a visible, logged placeholder", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const html = renderTreeToHtml([{ kind: "custom", component: "pdfOnly", props: undefined }], defaultTheme, customBlocks);

    expect(html).toContain('class="legal-doc__unsupported"');
    expect(html).toContain("[unsupported block: pdfOnly in html]");
    expect(warn).toHaveBeenCalledWith("[unsupported block: pdfOnly in html]");
    warn.mockRestore();
  });

  it("fails hard for a missing html impl in throw mode", () => {
    expect(() =>
      renderTreeToHtml([{ kind: "custom", component: "pdfOnly", props: undefined }], defaultTheme, customBlocks, "throw"),
    ).toThrow(/Custom block "pdfOnly" cannot render in "html"/);
  });

  it("validates Custom block props and rethrows a custom-block-framed error", () => {
    expect(() =>
      renderTreeToHtml([{ kind: "custom", component: "strict", props: { label: 123 } }], defaultTheme, customBlocks),
    ).toThrow(/Custom block "strict" received invalid props/);
  });

  it("derives the stylesheet from the Theme (an overridden token changes the CSS)", () => {
    const themed = { ...defaultTheme, fontSize: { ...defaultTheme.fontSize, title: 99 } };

    expect(renderTreeToHtml([{ kind: "title", text: "X" }], themed)).toContain("font-size:99px");
  });

  it("renders bullet and alpha lists with the right tag and class", () => {
    const bullet = renderTreeToHtml([{ kind: "bulletList", items: [[{ kind: "paragraph", text: "x" }]] }]);
    const alpha = renderTreeToHtml([{ kind: "alphaList", items: [[{ kind: "paragraph", text: "x" }]] }]);

    expect(bullet).toContain('<ul class="list">');
    expect(alpha).toContain('<ol class="list list--alpha">');
  });

  it("renders party address and omits a sig role when absent", () => {
    const html = renderTreeToHtml([
      { kind: "partyHeader", party: { name: "P", address: "1 St" }, roleLabel: "R" },
      { kind: "signatures", places: [{ name: "Solo" }] },
    ]);

    expect(html).toContain("1 St");
    expect(html).not.toContain('class="sig__role"'); // the element, not the (always-present) CSS rule
  });

  it("renders an empty tree as just the scoped wrapper", () => {
    expect(renderTreeToHtml([])).toMatch(/^<div class="legal-doc"><style>.*<\/style><\/div>$/s);
  });
});
