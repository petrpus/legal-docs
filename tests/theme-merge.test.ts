import { describe, it, expect } from "vitest";
import { mergeTheme, defaultTheme } from "../src/theme";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { MemoryCatalogStore } from "../src/catalog/memory-catalog-store";

describe("mergeTheme", () => {
  it("returns defaultTheme unchanged when given no partial", () => {
    expect(mergeTheme()).toBe(defaultTheme);
  });

  it("overrides a single nested token, keeping every other token at its default", () => {
    const merged = mergeTheme({ fontSize: { title: 22 } });

    expect(merged.fontSize.title).toBe(22);
    // The sibling token in the same group survives (proves a deep merge, not a shallow replace).
    expect(merged.fontSize.paragraph).toBe(defaultTheme.fontSize.paragraph);
    // An untouched group is identical to the default.
    expect(merged.page).toEqual(defaultTheme.page);
    expect(merged.color).toEqual(defaultTheme.color);
  });

  it("replaces a tuple/array token wholesale (arrays are leaves, not element-merged)", () => {
    const merged = mergeTheme({ article: { headingFontSize: [20, 18, 16] } });

    expect(merged.article.headingFontSize).toEqual([20, 18, 16]);
    // Sibling scalars in the same group are preserved.
    expect(merged.article.gap).toBe(defaultTheme.article.gap);
  });

  it("does not mutate defaultTheme", () => {
    mergeTheme({ fontSize: { title: 99 } });
    expect(defaultTheme.fontSize.title).toBe(18);
  });
});

describe("renderDocument accepts a partial theme", () => {
  it("applies a one-token override without re-spreading the whole Theme", async () => {
    const store = new MemoryCatalogStore({
      templates: [
        {
          template: "t",
          version: 1,
          locale: "en",
          body: [{ paragraph: "Hello" }],
        },
      ],
    });
    const catalog = Catalog.fromStore(store);

    const { html } = await renderDocument({
      catalog,
      template: "t",
      data: {},
      // Only one token supplied — the rest must come from defaultTheme via mergeTheme.
      theme: { color: { text: "#ff0000" } },
      format: "html",
    });

    expect(html).toContain("#ff0000");
  });
});
