import { describe, it, expect } from "vitest";
import { halfPoints, twips, eighths } from "../src/render-docx/theme-docx";

describe("theme-docx unit conversions", () => {
  it("converts points to half-points (×2)", () => {
    expect(halfPoints(11)).toBe(22);
    expect(halfPoints(18)).toBe(36);
  });

  it("converts points to twips (×20)", () => {
    expect(twips(8)).toBe(160);
    expect(twips(14)).toBe(280);
  });

  it("converts points to eighths of a point (×8, rounded)", () => {
    expect(eighths(1)).toBe(8);
    expect(eighths(0.75)).toBe(6);
  });
});
