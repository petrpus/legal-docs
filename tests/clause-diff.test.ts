import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { diffRichText } from "../src/core/clause-diff";
import { parseRichText } from "../src/core/rich-text";
import { Catalog } from "../src/catalog/catalog";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "fixtures", "clause-diff");

const diff = (a: string, b: string) => diffRichText(parseRichText(a), parseRichText(b));

describe("diffRichText", () => {
  it("returns no changes for identical rich text", () => {
    expect(diff("One.\n\nTwo.", "One.\n\nTwo.")).toEqual([]);
  });

  it("reports a changed paragraph as a replacement", () => {
    expect(diff("The fee is 5%.", "The fee is 7%.")).toEqual([
      { op: "replaced", before: "The fee is 5%.", after: "The fee is 7%." },
    ]);
  });

  it("reports an appended paragraph as an addition (unchanged blocks omitted)", () => {
    expect(diff("Intro.", "Intro.\n\nNew clause.")).toEqual([{ op: "added", text: "New clause." }]);
  });

  it("reports a deleted paragraph as a removal", () => {
    expect(diff("Keep.\n\nDrop.", "Keep.")).toEqual([{ op: "removed", text: "Drop." }]);
  });

  it("pairs positionally then appends a leftover removed block (removed > added in one run)", () => {
    expect(diff("M.\n\nX.\n\nY.", "M.\n\nZ.")).toEqual([
      { op: "replaced", before: "X.", after: "Z." },
      { op: "removed", text: "Y." },
    ]);
  });

  it("pairs positionally then appends a leftover added block (added > removed in one run)", () => {
    expect(diff("M.\n\nX.", "M.\n\nZ.\n\nW.")).toEqual([
      { op: "replaced", before: "X.", after: "Z." },
      { op: "added", text: "W." },
    ]);
  });

  it("handles a replacement plus an addition around an unchanged block", () => {
    const changes = diff("A old.\n\nMiddle.", "A new.\n\nMiddle.\n\nC added.");

    expect(changes).toEqual([
      { op: "replaced", before: "A old.", after: "A new." },
      { op: "added", text: "C added." },
    ]);
  });
});

describe("Catalog.clauses.diff", () => {
  it("diffs two versions of a Clause from the catalog", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const result = await catalog.clauses.diff("policy", { from: 1, to: 2 });

    expect(result).toMatchObject({ clause: "policy", from: 1, to: 2, locale: "en" });
    expect(result.changes).toEqual([
      {
        op: "replaced",
        before: "The borrower shall repay the loan in full.",
        after: "The borrower shall repay the loan within thirty days.",
      },
      { op: "added", text: "Late payment incurs a penalty." },
    ]);
  });

  it("fails fast for an unknown clause id", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    await expect(catalog.clauses.diff("ghost", { from: 1, to: 2 })).rejects.toThrow(
      /Cannot diff clause "ghost"/,
    );
  });

  it("fails fast for an unknown version", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    await expect(catalog.clauses.diff("policy", { from: 1, to: 9 })).rejects.toThrow(
      /Cannot diff clause "policy" v9/,
    );
  });
});
