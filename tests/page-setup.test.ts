import { describe, it, expect } from "vitest";
import { renderTreeToPdf } from "../src/render-pdf/render-pdf";
import { PAGE_SIZES, effectivePage } from "../src/core/page";
import { defaultTheme, mergeTheme } from "../src/theme";
import type { DocumentBody } from "../src/core/document-tree";

const body: DocumentBody = [{ kind: "paragraph", text: "Page geometry probe." }];

/** The first page's MediaBox [width, height] from a rendered PDF (react-pdf stores float32 values). */
function mediaBox(buffer: Buffer): [number, number] {
  const match = buffer.toString("latin1").match(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
  if (!match) throw new Error("No MediaBox found in PDF buffer");
  return [Number(match[1]), Number(match[2])];
}

describe("effectivePage — precedence", () => {
  it("defaults to the theme's A4 portrait", () => {
    expect(effectivePage(defaultTheme)).toEqual({ size: "A4", orientation: "portrait" });
  });

  it("reads a themed size and orientation", () => {
    const theme = mergeTheme({ page: { size: "LEGAL", orientation: "landscape" } });
    expect(effectivePage(theme)).toEqual({ size: "LEGAL", orientation: "landscape" });
  });

  it("lets an override win per-field, falling back to the theme for the rest", () => {
    const theme = mergeTheme({ page: { size: "LETTER", orientation: "landscape" } });
    expect(effectivePage(theme, { size: "A5" })).toEqual({ size: "A5", orientation: "landscape" });
    expect(effectivePage(theme, { orientation: "portrait" })).toEqual({ size: "LETTER", orientation: "portrait" });
    expect(effectivePage(theme, {})).toEqual({ size: "LETTER", orientation: "landscape" });
  });
});

describe("PAGE_SIZES — dimension table", () => {
  it("covers the standard set with portrait dimensions in points", () => {
    expect(Object.keys(PAGE_SIZES).sort()).toEqual(["A3", "A4", "A5", "LEGAL", "LETTER", "TABLOID"]);
    for (const { width, height } of Object.values(PAGE_SIZES)) {
      expect(width).toBeLessThan(height); // portrait reference — orientation swaps at render time
    }
  });
});

describe("page geometry — PDF", () => {
  it("renders A4 portrait by default", async () => {
    const [w, h] = mediaBox(await renderTreeToPdf(body));
    expect(w).toBeCloseTo(PAGE_SIZES.A4.width, 1);
    expect(h).toBeCloseTo(PAGE_SIZES.A4.height, 1);
  });

  it("renders a themed LEGAL landscape page (swapped MediaBox)", async () => {
    const buffer = await renderTreeToPdf(body, { theme: { page: { size: "LEGAL", orientation: "landscape" } } });
    const [w, h] = mediaBox(buffer);
    expect(w).toBeCloseTo(PAGE_SIZES.LEGAL.height, 1);
    expect(h).toBeCloseTo(PAGE_SIZES.LEGAL.width, 1);
  });

  it("renders every named format at its portrait dimensions", async () => {
    for (const size of Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]) {
      const dims = PAGE_SIZES[size];
      const buffer = await renderTreeToPdf(body, { theme: { page: { size } } });
      const [w, h] = mediaBox(buffer);
      expect(w, `${size} width`).toBeCloseTo(dims.width, 1);
      expect(h, `${size} height`).toBeCloseTo(dims.height, 1);
    }
  });
});

describe("page geometry — public surface", () => {
  it("exports the page module from the package entry point", async () => {
    const pkg = await import("../src/index");
    expect(pkg.PAGE_SIZES).toBe(PAGE_SIZES);
    expect(pkg.effectivePage).toBe(effectivePage);
  });
});
