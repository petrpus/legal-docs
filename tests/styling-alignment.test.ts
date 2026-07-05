import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { assembleTree } from "../src/core/engine";
import type { Template } from "../src/core/template";
import { renderTreeToHtml } from "../src/render-html/render-html";
import { renderTreeToDocx } from "../src/render-docx/render-docx";
import { defaultTheme } from "../src/render-pdf/theme";
import type { DocumentTree } from "../src/core/document-tree";

/** The raw word/document.xml of a .docx Buffer. */
async function docXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("no word/document.xml in the .docx");
  return file.async("string");
}

const tmpl = (body: Template["body"]): Template => ({ template: "t", version: 1, locale: "en", body });

describe("block-level alignment (ADR-0008)", () => {
  describe("authoring → engine", () => {
    it("the string shorthand produces a node with no align field (unchanged shape)", async () => {
      expect(await assembleTree(tmpl([{ title: "Hello" }, { paragraph: "World" }]))).toEqual([
        { kind: "title", text: "Hello" },
        { kind: "paragraph", text: "World" },
      ]);
    });

    it("the object form carries a per-block align override onto the node", async () => {
      expect(
        await assembleTree(
          tmpl([
            { title: { text: "SMLOUVA", align: "center" } },
            { paragraph: { text: "body", align: "justify" } },
          ]),
        ),
      ).toEqual([
        { kind: "title", text: "SMLOUVA", align: "center" },
        { kind: "paragraph", text: "body", align: "justify" },
      ]);
    });

    it("still interpolates the object form's text", async () => {
      const template: Template = {
        ...tmpl([{ paragraph: { text: "Dear {{ $name }}", align: "right" } }]),
        payloadSchema: undefined,
      };
      const tree = await assembleTree(template, { scope: { name: "Alice" } });
      expect(tree).toEqual([{ kind: "paragraph", text: "Dear Alice", align: "right" }]);
    });

    it("rejects an invalid align value at assembly (the closed-enum guard)", async () => {
      const body = [{ paragraph: { text: "X", align: "centre" } }] as unknown as Template["body"];
      await expect(assembleTree(tmpl(body))).rejects.toThrow(/Invalid paragraph align "centre"/);
    });
  });

  describe("HTML renderer", () => {
    it("emits the Theme default alignment in the class CSS", () => {
      const html = renderTreeToHtml([{ kind: "title", text: "X" }], defaultTheme);
      expect(html).toContain(".legal-doc .title{"); // class rule exists
      expect(html).toContain("text-align:left"); // default
    });

    it("reflects a themed default alignment", () => {
      const themed = { ...defaultTheme, align: { title: "center" as const, paragraph: "justify" as const } };
      const html = renderTreeToHtml([{ kind: "paragraph", text: "X" }], themed);
      expect(html).toContain("text-align:justify");
    });

    it("emits an inline style for a per-block override, winning over the class", () => {
      const html = renderTreeToHtml(
        [
          { kind: "title", text: "X", align: "center" },
          { kind: "paragraph", text: "Y", align: "right" },
        ],
        defaultTheme,
      );
      expect(html).toContain(`<h1 class="title" style="text-align:center">`);
      expect(html).toContain(`<p style="text-align:right">`);
    });

    it("omits the inline style when there is no override", () => {
      const html = renderTreeToHtml([{ kind: "paragraph", text: "Y" }], defaultTheme);
      expect(html).toContain("<p>Y</p>");
    });
  });

  describe("DOCX renderer", () => {
    it("emits no <w:jc> for the all-left default", async () => {
      const tree: DocumentTree = [
        { kind: "title", text: "T" },
        { kind: "paragraph", text: "P" },
      ];
      const xml = await docXml(await renderTreeToDocx(tree));
      expect(xml).not.toContain("<w:jc");
    });

    it("emits <w:jc> for a per-block override (center) and a themed justify default", async () => {
      const centered = await docXml(await renderTreeToDocx([{ kind: "title", text: "T", align: "center" }]));
      expect(centered).toContain('w:jc w:val="center"');

      const themed = { ...defaultTheme, align: { title: "left" as const, paragraph: "justify" as const } };
      const justified = await docXml(await renderTreeToDocx([{ kind: "paragraph", text: "P" }], themed));
      expect(justified).toContain("<w:jc"); // JUSTIFIED serializes as w:val="both"
    });

    it("does not leak a themed paragraph alignment into partyHeader (out of ADR-0008 scope)", async () => {
      const themed = { ...defaultTheme, align: { title: "left" as const, paragraph: "justify" as const } };
      const xml = await docXml(
        await renderTreeToDocx([{ kind: "partyHeader", party: { name: "Acme" }, roleLabel: "Lender" }], themed),
      );
      expect(xml).not.toContain("<w:jc");
    });
  });
});
