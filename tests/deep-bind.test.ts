import { describe, it, expect } from "vitest";
import { deepBind } from "../src/core/deep-bind";
import type { EvalContext } from "../src/core/expression";

const ctx: EvalContext = { scope: { x: 5, y: { name: "Acme" }, list: [1, 2] }, helpers: {} };

describe("deepBind", () => {
  it("evaluates a $-string leaf", () => {
    expect(deepBind("$x", ctx)).toBe(5);
  });

  it("leaves a non-$ string, number, boolean and null untouched", () => {
    expect(deepBind("literal", ctx)).toBe("literal");
    expect(deepBind(42, ctx)).toBe(42);
    expect(deepBind(true, ctx)).toBe(true);
    expect(deepBind(null, ctx)).toBe(null);
  });

  it("substitutes $-paths nested in objects, keeping literals", () => {
    expect(deepBind({ a: "$x", b: "lit", c: { d: "$y" } }, ctx)).toEqual({
      a: 5,
      b: "lit",
      c: { d: { name: "Acme" } },
    });
  });

  it("substitutes $-paths nested in arrays", () => {
    expect(deepBind(["$x", "lit", { e: "$x" }], ctx)).toEqual([5, "lit", { e: 5 }]);
  });

  it("resolves a deeper $-path", () => {
    expect(deepBind("$y.name", ctx)).toBe("Acme");
  });

  it("passes an exotic object (Date) through untouched instead of flattening it", () => {
    const date = new Date(0);
    expect(deepBind({ when: date }, ctx)).toEqual({ when: date });
    expect((deepBind({ when: date }, ctx) as { when: Date }).when).toBeInstanceOf(Date);
  });
});
