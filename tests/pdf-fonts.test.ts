import { describe, it, expect } from "vitest";
import { PDFParse } from "pdf-parse";
import { renderTreeToBuffer } from "../src/render-pdf/render-pdf";
import { parseRichText } from "../src/core/rich-text";

async function pdfText(buffer: Buffer): Promise<string> {
  return (await new PDFParse({ data: buffer }).getText()).text;
}

/**
 * react-pdf's built-in Helvetica (WinAnsi) mangles Czech diacritics — "Příliš žluťoučký kůň" renders
 * as "PYíliš žlueou ký koH". The bundled Liberation Serif (registered by default) fixes it. These
 * assert the EXACT string round-trips, which the built-in font provably fails.
 */
describe("PDF fonts — diacritics (Wave 1)", () => {
  const czech = "Příliš žluťoučký kůň úpěl ďábelské ódy.";

  it("renders Czech diacritics correctly in a paragraph (default theme font)", async () => {
    const text = await pdfText(await renderTreeToBuffer([{ kind: "paragraph", text: czech }]));
    expect(text).toContain(czech);
  });

  it("renders Czech diacritics in a bold run (the family's bold face carries the glyphs)", async () => {
    const bold = "**žluťoučký kůň ďábelské**";
    const text = await pdfText(await renderTreeToBuffer([{ kind: "richText", value: parseRichText(bold) }]));
    expect(text).toContain("žluťoučký kůň ďábelské");
  });

  it("renders a title's diacritics (font cascades from the Page)", async () => {
    const text = await pdfText(await renderTreeToBuffer([{ kind: "title", text: "SMLOUVA O ZÁPŮJČCE" }]));
    expect(text).toContain("SMLOUVA O ZÁPŮJČCE");
  });
});
