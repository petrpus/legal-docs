import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { Font } from "@react-pdf/renderer";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "..", "legal-docs");

type Source = { data?: { _glyphs?: Record<number, unknown> } | null };

function cachedGlyphCount(): number {
  const families = Font.getRegisteredFonts() as Record<string, { sources?: Source[] }>;
  let n = 0;
  for (const family of Object.values(families)) {
    for (const source of family?.sources ?? []) n += Object.keys(source.data?._glyphs ?? {}).length;
  }
  return n;
}

/**
 * fontkit memoises Glyph objects on each loaded font and pdfkit writes subset state into them, so a
 * glyph cached by one document poisons the subset of the next one that needs it — a character goes
 * missing from the page. A PDF render must therefore leave no glyph cached on any registered font.
 */
describe("renderTreeToPdf and the shared glyph cache", () => {
  it("leaves no glyphs cached on registered fonts after a render", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    // A capital with an acute accent is what seeds the cross-document corruption in practice.
    await renderDocument({ catalog, template: "hello", format: "pdf" });
    expect(cachedGlyphCount()).toBe(0);
  }, 60_000);

  it("clears a cache left behind by someone else before rendering", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    await renderDocument({ catalog, template: "hello", format: "pdf" });
    // Simulate a foreign render that populated the cache and did not clean up.
    const families = Font.getRegisteredFonts() as Record<string, { sources?: Source[] }>;
    const source = Object.values(families).flatMap((f) => f.sources ?? []).find((s) => s.data);
    expect(source?.data).toBeTruthy();
    source!.data!._glyphs = { 472: { id: 472 } };
    expect(cachedGlyphCount()).toBeGreaterThan(0);

    await renderDocument({ catalog, template: "hello", format: "pdf" });
    expect(cachedGlyphCount()).toBe(0);
  }, 60_000);
});
