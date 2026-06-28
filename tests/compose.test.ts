import { describe, it, expect } from "vitest";
import { composeTemplate, CompositionError } from "../src/core/compose";
import type { BaseTemplate, Variant } from "../src/core/template";

const base: BaseTemplate = {
  base: "greet",
  version: 2,
  locale: "en",
  payloadSchema: "greet@2",
  derivations: ["counterpartsCount"],
  body: [
    { title: "Greetings" },
    { slot: "intro" },
    { for: { each: "$parties", as: "p" }, body: [{ paragraph: "Party {{ $p }}" }] },
    { slot: "closing" },
  ],
};

const twoParty: Variant = {
  variant: "two-party",
  extends: "greet",
  parties: ["lender", "pledgor"],
  overrides: {
    intro: [{ paragraph: "Two-party intro" }],
    closing: [{ paragraph: "Signed by two." }],
  },
};

describe("composeTemplate", () => {
  it("fills declared Slots and preserves the surrounding base structure", () => {
    const composed = composeTemplate(base, twoParty);

    expect(composed.body).toEqual([
      { title: "Greetings" },
      { paragraph: "Two-party intro" },
      { for: { each: "$parties", as: "p" }, body: [{ paragraph: "Party {{ $p }}" }] },
      { paragraph: "Signed by two." },
    ]);
  });

  it("carries variant identity, parties, and base metadata onto the concrete Template", () => {
    const composed = composeTemplate(base, twoParty);

    expect(composed).toMatchObject({
      template: "greet",
      version: 2,
      locale: "en",
      payloadSchema: "greet@2",
      derivations: ["counterpartsCount"],
      variant: "two-party",
      parties: ["lender", "pledgor"],
    });
  });

  it("removes a Slot the Variant does not fill", () => {
    const composed = composeTemplate(base, {
      variant: "intro-only",
      extends: "greet",
      overrides: { intro: [{ paragraph: "Only intro" }] },
    });

    expect(composed.body).toEqual([
      { title: "Greetings" },
      { paragraph: "Only intro" },
      { for: { each: "$parties", as: "p" }, body: [{ paragraph: "Party {{ $p }}" }] },
    ]);
  });

  it("fills Slots nested inside if/for/article/list bodies", () => {
    const nestedBase: BaseTemplate = {
      base: "nested",
      version: 1,
      locale: "en",
      body: [
        { if: "$flag", then: [{ slot: "a" }], else: [{ slot: "b" }] },
        { article: { no: "1.", body: [{ slot: "c" }] } },
        { numberedList: [[{ slot: "d" }]] },
      ],
    };
    const composed = composeTemplate(nestedBase, {
      variant: "v",
      extends: "nested",
      overrides: {
        a: [{ paragraph: "A" }],
        b: [{ paragraph: "B" }],
        c: [{ paragraph: "C" }],
        d: [{ paragraph: "D" }],
      },
    });

    expect(composed.body).toEqual([
      { if: "$flag", then: [{ paragraph: "A" }], else: [{ paragraph: "B" }] },
      { article: { no: "1.", body: [{ paragraph: "C" }] } },
      { numberedList: [[{ paragraph: "D" }]] },
    ]);
  });

  it("rejects a Variant that overrides a Slot the base never declares", () => {
    expect(() =>
      composeTemplate(base, { variant: "bad", extends: "greet", overrides: { ghost: [] } }),
    ).toThrow(CompositionError);
  });

  it("rejects a Variant that extends a different family", () => {
    expect(() => composeTemplate(base, { variant: "x", extends: "other" })).toThrow(
      /extends "other" but the base is "greet"/,
    );
  });

  it("fills a Slot declared in both arms of an if (each occurrence gets the fill)", () => {
    const dupBase: BaseTemplate = {
      base: "dup",
      version: 1,
      locale: "en",
      body: [{ if: "$flag", then: [{ slot: "x" }], else: [{ slot: "x" }] }],
    };

    const composed = composeTemplate(dupBase, {
      variant: "v",
      extends: "dup",
      overrides: { x: [{ paragraph: "X" }] },
    });

    expect(composed.body).toEqual([
      { if: "$flag", then: [{ paragraph: "X" }], else: [{ paragraph: "X" }] },
    ]);
  });
});
