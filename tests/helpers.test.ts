import { describe, it, expect } from "vitest";
import { defaultHelpers, makeDefaultHelpers } from "../src/core/helpers";
import { LegalDocsError } from "../src/core/errors";
import { assembleTree } from "../src/core/engine";
import type { DocumentNode } from "../src/core/document-tree";
import { Catalog } from "../src/catalog/catalog";
import { MemoryCatalogStore } from "../src/catalog/memory-catalog-store";
import type { Template } from "../src/core/template";

const { formatDate, formatCurrency } = defaultHelpers;
// The registry is `Record<string, Helper>`, so lookups are `Helper | undefined`; this guard both
// narrows them for the tests and asserts the default helpers are actually registered.
if (!formatDate || !formatCurrency) throw new Error("default helpers are not registered");

/** Pull a locale-aware helper for a given locale, narrowed from the `Helper | undefined` lookup. */
function localeHelper(name: "formatDateLong" | "formatMoney", locale: string) {
  const h = makeDefaultHelpers(locale)[name];
  if (!h) throw new Error(`${name} is not registered`);
  return h;
}

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

// The locale-aware helpers use Intl, so exact output is ICU-version-dependent — assert tolerantly
// (locale actually changes the output, the year/currency survives) rather than pinning exact strings.
describe("makeDefaultHelpers.formatDateLong (locale-aware)", () => {
  it("formats a long date whose presentation differs by locale", () => {
    const en = localeHelper("formatDateLong", "en-US")("2026-07-06");
    const de = localeHelper("formatDateLong", "de-DE")("2026-07-06");
    expect(String(en)).toContain("2026");
    expect(String(de)).toContain("2026");
    // Different locales must render the month differently (proves locale is actually applied).
    expect(en).not.toBe(de);
  });

  it("keeps the calendar day stable across an offset (UTC time zone)", () => {
    // 23:30 at -05:00 is 04:30 UTC on the 7th; the long form must still report the 7th, not the 6th.
    expect(String(localeHelper("formatDateLong", "en-US")("2026-07-06T23:30:00-05:00"))).toContain("7");
  });

  it("throws a typed LegalDocsError on an unparseable date", () => {
    expect(() => localeHelper("formatDateLong", "en-US")("not-a-date")).toThrow(/invalid date/);
  });
});

describe("makeDefaultHelpers.formatMoney (locale-aware)", () => {
  it("formats currency whose presentation differs by locale", () => {
    const en = String(localeHelper("formatMoney", "en-US")(1000, "EUR"));
    const de = String(localeHelper("formatMoney", "de-DE")(1000, "EUR"));
    // Both carry the euro sign and the magnitude, but group/symbol placement differs by locale.
    expect(en).toContain("€");
    expect(de).toContain("€");
    expect(en).not.toBe(de);
  });

  it("throws when the amount is not a number or the currency is missing", () => {
    expect(() => localeHelper("formatMoney", "en-US")("abc", "EUR")).toThrow(/amount is not a number/);
    expect(() => localeHelper("formatMoney", "en-US")(1000)).toThrow(/currency is required/);
  });

  it("wraps an invalid currency code in a typed LegalDocsError (not a raw RangeError)", () => {
    const err = (() => {
      try {
        localeHelper("formatMoney", "en-US")(1000, "XX");
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(err).toBeInstanceOf(LegalDocsError);
    expect(err.message).toMatch(/invalid currency "XX"/);
  });
});

describe("validate() recognizes the locale-aware helpers as registered", () => {
  const template = (body: Template["body"]): Template => ({ template: "t", version: 1, locale: "en", body });

  it("does not flag formatMoney/formatDateLong as unregistered", async () => {
    const store = new MemoryCatalogStore({
      templates: [template([{ paragraph: "{{ formatMoney($x, 'EUR') }} {{ formatDateLong($d) }}" }])],
    });
    const result = await Catalog.fromStore(store).validate();
    expect(result.findings.filter((f) => /is not registered/.test(f.message))).toEqual([]);
  });

  it("still flags a genuinely unknown helper (control)", async () => {
    const store = new MemoryCatalogStore({
      templates: [template([{ paragraph: "{{ mysteryHelper($x) }}" }])],
    });
    const result = await Catalog.fromStore(store).validate();
    expect(result.findings.some((f) => /helper "mysteryHelper" is not registered/.test(f.message))).toBe(true);
  });
});

describe("engine binds the render locale into the built-in helpers", () => {
  const paragraphText = async (locale: string): Promise<string> => {
    const tree = await assembleTree(
      { template: "t", version: 1, locale, body: [{ paragraph: "{{ formatMoney($amount, 'EUR') }}" }] },
      { scope: { amount: 1000 }, locale },
    );
    const node = tree.find((n: DocumentNode) => n.kind === "paragraph");
    if (!node || node.kind !== "paragraph") throw new Error("no paragraph node");
    return node.text;
  };

  it("renders formatMoney differently for different render locales", async () => {
    const en = await paragraphText("en-US");
    const de = await paragraphText("de-DE");
    expect(en).toContain("€");
    expect(de).toContain("€");
    // The engine passed the render locale through to the helper — output is locale-specific.
    expect(en).not.toBe(de);
  });
});
