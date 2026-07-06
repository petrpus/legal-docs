import { describe, it, expect } from "vitest";
import { defaultHelpers } from "../src/core/helpers";
import { LegalDocsError } from "../src/core/errors";

const { formatDate, formatCurrency } = defaultHelpers;
// The registry is `Record<string, Helper>`, so lookups are `Helper | undefined`; this guard both
// narrows them for the tests and asserts the default helpers are actually registered.
if (!formatDate || !formatCurrency) throw new Error("default helpers are not registered");

describe("defaultHelpers.formatDate", () => {
  it("formats an ISO date string to YYYY-MM-DD", () => {
    expect(formatDate("2026-07-06")).toBe("2026-07-06");
  });

  it("keeps only the date part of a date-time", () => {
    expect(formatDate("2026-07-06T15:30:00Z")).toBe("2026-07-06");
  });

  it("normalizes to UTC (the documented contract), shifting the day across an offset", () => {
    // 23:30 at -05:00 is 04:30 UTC the next day; formatDate reports the UTC day. This pins the
    // ISO/UTC contract so a future reader doesn't assume local-time formatting.
    expect(formatDate("2026-07-06T23:30:00-05:00")).toBe("2026-07-07");
  });

  it("throws a typed LegalDocsError on an unparseable date", () => {
    expect(() => formatDate("not-a-date")).toThrow(LegalDocsError);
    expect(() => formatDate("not-a-date")).toThrow(/invalid date/);
  });

  it("throws on a missing argument (undefined coerces to an invalid date)", () => {
    expect(() => formatDate()).toThrow(/invalid date/);
  });
});

describe("defaultHelpers.formatCurrency", () => {
  it("formats an amount with two decimals and a currency prefix", () => {
    expect(formatCurrency(1000, "EUR")).toBe("EUR 1000.00");
    expect(formatCurrency(1234.5, "USD")).toBe("USD 1234.50");
  });

  it("handles a negative amount", () => {
    expect(formatCurrency(-42, "GBP")).toBe("GBP -42.00");
  });

  it("omits the prefix (and trims) when no currency is given", () => {
    expect(formatCurrency(9.99)).toBe("9.99");
  });

  it("throws a typed LegalDocsError when the amount is not a number", () => {
    expect(() => formatCurrency("abc", "EUR")).toThrow(LegalDocsError);
    expect(() => formatCurrency("abc", "EUR")).toThrow(/amount is not a number/);
  });
});
