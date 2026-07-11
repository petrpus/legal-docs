import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { assembleDocument } from "../src/core/engine";
import { renderTreeToDocx } from "../src/render-docx/render-docx";
import type { Template } from "../src/core/template";

const headed: Template = {
  template: "nda",
  version: 1,
  locale: "en",
  body: [{ paragraph: "Body text." }],
  header: { left: "{{ $party }}", right: "{{ $page.number }} / {{ $page.total }}" },
  footer: { center: "Confidential" },
};

/** Concatenate every header/footer part XML of a .docx buffer (each lives in its own part). */
async function furnitureXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const parts = Object.keys(zip.files).filter((name) => /^word\/(header|footer)\d+\.xml$/.test(name));
  const texts = await Promise.all(parts.map((name) => zip.files[name]!.async("string")));
  return texts.join("\n");
}

/** The main body document.xml — furniture must NOT leak into it. */
async function bodyXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return zip.file("word/document.xml")!.async("string");
}

describe("DOCX page furniture", () => {
  it("emits header/footer parts carrying the interpolated text", async () => {
    const tree = await assembleDocument(headed, { scope: { party: "ACME" } });
    const xml = await furnitureXml(await renderTreeToDocx(tree));
    expect(xml).toContain("ACME");
    expect(xml).toContain("Confidential");
  });

  it("renders page numbers as PAGE / NUMPAGES fields, not raw sentinels", async () => {
    const tree = await assembleDocument(headed, { scope: { party: "ACME" } });
    const xml = await furnitureXml(await renderTreeToDocx(tree));
    // docx PageNumber.CURRENT / TOTAL_PAGES become Word field instructions.
    expect(xml).toMatch(/\bPAGE\b/);
    expect(xml).toContain("NUMPAGES");
    // The plain-text run between the two fields (" / ") survives the sentinel split.
    expect(xml).toMatch(/<w:t[^>]*>\s*\/\s*<\/w:t>/);
    // No private-use sentinel leaks into the output.
    expect(xml).not.toContain("page.number");
  });

  it("keeps furniture out of the main body document.xml", async () => {
    const tree = await assembleDocument(headed, { scope: { party: "ACME" } });
    const body = await bodyXml(await renderTreeToDocx(tree));
    expect(body).toContain("Body text.");
    expect(body).not.toContain("Confidential");
  });

  it("omits header/footer parts entirely when the template declares none", async () => {
    const tree = await assembleDocument({ template: "t", version: 1, locale: "en", body: [{ paragraph: "x" }] });
    const xml = await furnitureXml(await renderTreeToDocx(tree));
    expect(xml).toBe("");
  });
});
