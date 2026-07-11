import { describe, it, expect } from "vitest";
import { evaluate, ExpressionError, type EvalContext } from "../src/core/expression";

function ctx(scope: Record<string, unknown> = {}, helpers = {}): EvalContext {
  return { scope, helpers };
}

describe("evaluate", () => {
  it("resolves $-rooted payload paths, including nested members", () => {
    expect(evaluate("$name", ctx({ name: "Alice" }))).toBe("Alice");
    expect(evaluate("$loan.principal.amount", ctx({ loan: { principal: { amount: 1000 } } }))).toBe(
      1000,
    );
  });

  it("evaluates equality and boolean logic", () => {
    expect(evaluate("$x == 2", ctx({ x: 2 }))).toBe(true);
    expect(evaluate("$x != 2", ctx({ x: 3 }))).toBe(true);
    expect(evaluate("$a && $b", ctx({ a: true, b: false }))).toBe(false);
    expect(evaluate("$a || $b", ctx({ a: false, b: true }))).toBe(true);
    expect(evaluate("!$a", ctx({ a: false }))).toBe(true);
  });

  it("evaluates a ternary and arithmetic", () => {
    expect(evaluate("$n >= 3 ? 'many' : 'few'", ctx({ n: 5 }))).toBe("many");
    expect(evaluate("$n + 1", ctx({ n: 4 }))).toBe(5);
  });

  it("evaluates the full arithmetic operator set", () => {
    expect(evaluate("$a - $b", ctx({ a: 7, b: 2 }))).toBe(5);
    expect(evaluate("$a * $b", ctx({ a: 6, b: 7 }))).toBe(42);
    expect(evaluate("$a / $b", ctx({ a: 9, b: 3 }))).toBe(3);
    expect(evaluate("$a % $b", ctx({ a: 10, b: 3 }))).toBe(1);
  });

  it("rejects division and modulo by zero instead of leaking Infinity/NaN", () => {
    // 1 / 0 → Infinity, 0 / 0 → NaN; both would otherwise render literally in the document.
    expect(() => evaluate("$a / 0", ctx({ a: 1 }))).toThrow(/Division by zero/);
    expect(() => evaluate("0 / 0", ctx())).toThrow(/Division by zero/);
    expect(() => evaluate("$a % 0", ctx({ a: 5 }))).toThrow(/Modulo by zero/);
  });

  it("rejects a non-finite operand (a literal or coerced Infinity) as not a finite number", () => {
    expect(() => evaluate("$x + 1", ctx({ x: Infinity }))).toThrow(/Not a finite number/);
    expect(() => evaluate("$x * 2", ctx({ x: "Infinity" }))).toThrow(/Not a finite number/);
  });

  it("rejects a non-finite operand in a comparison too (not just arithmetic)", () => {
    // Pins intent: the isFinite guard in toNumber deliberately covers the comparison path, so a future
    // reader doesn't relax it back to isNaN and let Infinity through `<`/`>`.
    expect(() => evaluate("$x < 100", ctx({ x: Infinity }))).toThrow(/Not a finite number/);
  });

  it("rejects an arithmetic result that overflows to a non-finite value", () => {
    // Two finite operands whose product overflows to Infinity must not leak into output.
    expect(() => evaluate("$x * $x", ctx({ x: 1e308 }))).toThrow(/non-finite result/);
  });

  it("calls whitelisted helpers", () => {
    const helpers = { upper: (...args: unknown[]) => String(args[0]).toUpperCase() };
    expect(evaluate("upper($s)", ctx({ s: "hi" }, helpers))).toBe("HI");
  });

  it("rejects unknown helpers", () => {
    expect(() => evaluate("foo()", ctx())).toThrow(ExpressionError);
  });

  it("rejects member-method calls", () => {
    expect(() => evaluate("$s.toString()", ctx({ s: "x" }))).toThrow(/whitelisted helpers/);
  });

  it("rejects bare identifiers used as values", () => {
    expect(() => evaluate("name", ctx({ name: "Alice" }))).toThrow(/must start with/);
  });

  it("rejects assignment", () => {
    expect(() => evaluate("$x = 1", ctx({ x: 1 }))).toThrow(ExpressionError);
  });

  it("rejects access to prototype-chain keys", () => {
    expect(() => evaluate("$x.constructor", ctx({ x: {} }))).toThrow(/not allowed/);
    expect(() => evaluate("$x.__proto__", ctx({ x: {} }))).toThrow(/not allowed/);
    expect(() => evaluate("$x['constructor']", ctx({ x: {} }))).toThrow(/not allowed/);
  });

  it("supports nullish coalescing and optional chaining", () => {
    expect(evaluate("$x ?? 'fallback'", ctx({ x: null }))).toBe("fallback");
    expect(evaluate("$x ?? 'fallback'", ctx({ x: "set" }))).toBe("set");
    expect(evaluate("$a?.b", ctx({ a: null }))).toBeUndefined();
  });

  it("wraps a failing helper in an ExpressionError", () => {
    const helpers = {
      boom: () => {
        throw new Error("kaboom");
      },
    };
    expect(() => evaluate("boom()", ctx({}, helpers))).toThrow(/Helper "boom" failed: kaboom/);
  });
});
