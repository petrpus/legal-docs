import { describe, expect, it } from "vitest";
import { diffWords, lcsAlign, pairAligned } from "../src/core/text-diff";

describe("lcsAlign", () => {
  it("reports every element as equal for identical sequences, with both indices", () => {
    expect(lcsAlign(["a", "b"], ["a", "b"])).toEqual([
      { op: "equal", before: "a", after: "a", beforeIndex: 0, afterIndex: 0 },
      { op: "equal", before: "b", after: "b", beforeIndex: 1, afterIndex: 1 },
    ]);
  });

  it("returns nothing for two empty sequences", () => {
    expect(lcsAlign([], [])).toEqual([]);
  });

  it("reports an inserted element at its index in the AFTER sequence", () => {
    expect(lcsAlign(["a", "c"], ["a", "b", "c"])).toEqual([
      { op: "equal", before: "a", after: "a", beforeIndex: 0, afterIndex: 0 },
      { op: "added", after: "b", afterIndex: 1 },
      { op: "equal", before: "c", after: "c", beforeIndex: 1, afterIndex: 2 },
    ]);
  });

  it("reports a removed element at its index in the BEFORE sequence", () => {
    expect(lcsAlign(["a", "b", "c"], ["a", "c"])).toEqual([
      { op: "equal", before: "a", after: "a", beforeIndex: 0, afterIndex: 0 },
      { op: "removed", before: "b", beforeIndex: 1 },
      { op: "equal", before: "c", after: "c", beforeIndex: 2, afterIndex: 1 },
    ]);
  });

  it("puts the removal before the addition of a replaced element", () => {
    expect(lcsAlign(["a", "x", "c"], ["a", "y", "c"]).map((step) => step.op)).toEqual([
      "equal",
      "removed",
      "added",
      "equal",
    ]);
  });

  it("uses the supplied equality, so structurally equal objects align", () => {
    const same = (a: { id: number }, b: { id: number }) => a.id === b.id;
    const steps = lcsAlign([{ id: 1 }, { id: 2 }], [{ id: 1 }], same);
    expect(steps.map((step) => step.op)).toEqual(["equal", "removed"]);
  });
});

describe("pairAligned", () => {
  it("pairs a changed run positionally into replacements", () => {
    const runs = pairAligned(lcsAlign(["a", "x", "c"], ["a", "y", "c"]));
    expect(runs).toEqual([
      { op: "equal", before: "a", after: "a", beforeIndex: 0, afterIndex: 0 },
      { op: "replaced", before: "x", after: "y", beforeIndex: 1, afterIndex: 1 },
      { op: "equal", before: "c", after: "c", beforeIndex: 2, afterIndex: 2 },
    ]);
  });

  it("leaves the longer side's remainder as plain removals or additions", () => {
    const runs = pairAligned(lcsAlign(["x", "y"], ["p", "q", "r"]));
    expect(runs.map((run) => run.op)).toEqual(["replaced", "replaced", "added"]);
  });
});

describe("diffWords", () => {
  it("returns a single equal segment for identical text", () => {
    expect(diffWords("the same words", "the same words")).toEqual([{ op: "equal", text: "the same words" }]);
  });

  it("returns nothing for two empty strings", () => {
    expect(diffWords("", "")).toEqual([]);
  });

  it("marks an inserted word", () => {
    expect(diffWords("a b", "a x b")).toEqual([
      { op: "equal", text: "a " },
      { op: "ins", text: "x " },
      { op: "equal", text: "b" },
    ]);
  });

  it("marks a deleted word", () => {
    expect(diffWords("a x b", "a b")).toEqual([
      { op: "equal", text: "a " },
      { op: "del", text: "x " },
      { op: "equal", text: "b" },
    ]);
  });

  it("marks a replacement as a deletion followed by an insertion", () => {
    expect(diffWords("the red car", "the blue car")).toEqual([
      { op: "equal", text: "the " },
      { op: "del", text: "red" },
      { op: "ins", text: "blue" },
      { op: "equal", text: " car" },
    ]);
  });

  it("preserves whitespace runs as their own tokens", () => {
    expect(diffWords("a  b", "a b")).toEqual([
      { op: "equal", text: "a" },
      { op: "del", text: "  " },
      { op: "ins", text: " " },
      { op: "equal", text: "b" },
    ]);
  });

  it("keeps leading and trailing whitespace", () => {
    expect(diffWords("  padded  ", "  padded  ")).toEqual([{ op: "equal", text: "  padded  " }]);
  });

  it("diffs non-ASCII text by word", () => {
    expect(diffWords("Příloha č. 1 — Splátkový kalendář", "Příloha č. 2 — Splátkový kalendář")).toEqual([
      { op: "equal", text: "Příloha č. " },
      { op: "del", text: "1" },
      { op: "ins", text: "2" },
      { op: "equal", text: " — Splátkový kalendář" },
    ]);
  });

  it("keeps astral-plane characters intact", () => {
    expect(diffWords("sign 😀 here", "sign 🙂 here")).toEqual([
      { op: "equal", text: "sign " },
      { op: "del", text: "😀" },
      { op: "ins", text: "🙂" },
      { op: "equal", text: " here" },
    ]);
  });

  it("reassembles into the before text (equal + del) and the after text (equal + ins)", () => {
    const before = "The Borrower shall repay the Loan in 12 monthly instalments.";
    const after = "The Borrower shall repay the whole Loan in 24 instalments, monthly.";
    const segments = diffWords(before, after);
    const join = (ops: readonly string[]) =>
      segments.filter((segment) => ops.includes(segment.op)).map((segment) => segment.text).join("");
    expect(join(["equal", "del"])).toBe(before);
    expect(join(["equal", "ins"])).toBe(after);
  });
});
