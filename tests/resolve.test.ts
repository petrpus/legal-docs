import { describe, it, expect } from "vitest";
import { resolvePayload } from "../src/core/resolve";

describe("resolvePayload", () => {
  it("runs named derivations into $derived", () => {
    const registry = {
      count: (p: unknown) => (p as { xs: number[] }).xs.length,
      first: (p: unknown) => (p as { xs: number[] }).xs[0],
    };

    expect(resolvePayload({ xs: [10, 20, 30] }, ["count", "first"], registry)).toEqual({
      derived: { count: 3, first: 10 },
    });
  });

  it("throws on an unknown derivation", () => {
    expect(() => resolvePayload({}, ["nope"], {})).toThrow(/Unknown derivation: nope/);
  });

  it("wraps a failing derivation with its name", () => {
    const registry = {
      boom: () => {
        throw new Error("kaboom");
      },
    };
    expect(() => resolvePayload({}, ["boom"], registry)).toThrow(/Derivation "boom" failed: kaboom/);
  });
});
