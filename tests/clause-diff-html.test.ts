import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { renderClauseDiff } from "../src/render-html/clause-diff-html";
import { Catalog } from "../src/catalog/catalog";
import { defaultTheme } from "../src/theme";
import type { ClauseDiff } from "../src/core/clause-diff";

const here = path.dirname(fileURLToPath(import.meta.url));
const diffCatalogDir = path.join(here, "fixtures", "clause-diff");

const base = { clause: "policy", from: 1, to: 2, locale: "en" } as const;

describe("renderClauseDiff", () => {
  it("renders a self-contained fragment with a scoped style and header (golden)", () => {
    const diff: ClauseDiff = {
      ...base,
      changes: [
        { op: "replaced", before: "The fee is 5%.", after: "The fee is 7%." },
        { op: "added", text: "Late payment incurs a penalty." },
      ],
    };

    const html = renderClauseDiff(diff);

    expect(html.startsWith('<div class="clause-diff"><style>')).toBe(true);
    expect(html).toContain('<div class="clause-diff__header">policy: v1 → v2</div>');
    expect(html).toMatchSnapshot();
  });

  it("renders each change kind with a distinct class (replaced shows before and after)", () => {
    const diff: ClauseDiff = {
      ...base,
      changes: [
        { op: "added", text: "A" },
        { op: "removed", text: "B" },
        { op: "replaced", before: "C", after: "D" },
      ],
    };

    const html = renderClauseDiff(diff);

    expect(html).toContain('<div class="diff-added"><ins>A</ins></div>');
    expect(html).toContain('<div class="diff-removed"><del>B</del></div>');
    expect(html).toContain('<div class="diff-replaced"><del>C</del><ins>D</ins></div>');
  });

  it("renders a 'no changes' fragment (not an error) for an empty change set", () => {
    const html = renderClauseDiff({ ...base, changes: [] });

    expect(html).toContain('class="clause-diff__empty"');
    expect(html).toContain("No changes");
  });

  it("escapes diff text in every position — added, replaced before/after, and the clause name", () => {
    const html = renderClauseDiff({
      clause: "a&b<c>",
      from: 1,
      to: 2,
      locale: "en",
      changes: [
        { op: "added", text: "<script>x</script>" },
        { op: "replaced", before: "<i>old</i>", after: "<b>new</b>" },
      ],
    });

    expect(html).toContain("a&amp;b&lt;c&gt;"); // clause name
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;i&gt;old&lt;/i&gt;"); // replaced before
    expect(html).toContain("&lt;b&gt;new&lt;/b&gt;"); // replaced after
    expect(html).not.toContain("<script>x");
  });

  it("flows a custom Theme into the scoped style", () => {
    const themed = { ...defaultTheme, color: { ...defaultTheme.color, text: "#abcdef" } };

    expect(renderClauseDiff({ ...base, changes: [] }, themed)).toContain("color:#abcdef");
  });

  it("renders a diff produced by the unchanged catalog.clauses.diff", async () => {
    const catalog = await Catalog.fromDir(diffCatalogDir);
    const diff = await catalog.clauses.diff("policy", { from: 1, to: 2 });

    const html = renderClauseDiff(diff);

    expect(html).toContain("clause-diff");
    expect(html).toContain("Late payment incurs a penalty.");
  });
});
