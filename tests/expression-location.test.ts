import { describe, expect, it } from "vitest";
import {
  evaluate,
  evaluatePredicate,
  ExpressionError,
  parseExpression,
  type EvalContext,
} from "../src/core/expression";
import { interpolate } from "../src/core/interpolate";
import { assembleTree } from "../src/core/engine";
import type { Template } from "../src/core/template";

const boom = () => {
  throw new Error("boom");
};

function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  return { scope: {}, helpers: { boom }, ...overrides };
}

describe("ExpressionError location", () => {
  it("carries the offending expression in the message", () => {
    expect(() => evaluate("boom($x)", ctx())).toThrow(
      /Helper "boom" failed: boom .*expression: boom\(\$x\)/,
    );
  });

  it("carries the body path and iteration when the context has a location", () => {
    const located = ctx({ at: { path: "body[3] › for", iteration: 2 } });
    try {
      evaluate("boom($x)", located);
      throw new Error("expected an ExpressionError");
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      expect(error.message).toContain("at body[3] › for, iteration 2");
      expect(error.message).toContain("expression: boom($x)");
      expect(error.location).toEqual({ path: "body[3] › for", iteration: 2 });
      expect(error.expression).toBe("boom($x)");
    }
  });

  it("annotates once — interpolate over evaluate does not double-annotate", () => {
    const located = ctx({ at: { path: "body[0]" } });
    try {
      interpolate("Total: {{ boom($x) }}", located);
      throw new Error("expected an ExpressionError");
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      expect(error.message.match(/expression:/g)).toHaveLength(1);
      expect(error.message.match(/at body\[0\]/g)).toHaveLength(1);
    }
  });

  it("locates predicate-rule violations too", () => {
    const located = ctx({ at: { path: "body[1] › then[0]" } });
    expect(() => evaluatePredicate("$a + 1", located)).toThrow(
      /is computation.*at body\[1\] › then\[0\].*expression: \$a \+ 1/s,
    );
  });
});

describe("parseExpression cache", () => {
  it("returns the same AST object for a repeated expression", () => {
    expect(parseExpression("$a == 1")).toBe(parseExpression("$a == 1"));
  });

  it("still throws a located parse error for garbage", () => {
    expect(() => evaluate("$a ===", ctx())).toThrow(/Cannot parse expression/);
  });
});

describe("tree assembly reports where an expression failed", () => {
  it("names the body path and for-iteration in the error", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [
        { title: "OK" },
        {
          for: { each: "$items", as: "item" },
          body: [{ paragraph: "{{ boom($item) }}" }],
        },
      ],
    };
    await expect(
      assembleTree(template, { scope: { items: [1, 2, 3] }, helpers: { boom } }),
    ).rejects.toThrow(/at body\[1\] › for\[0\], iteration 0.*expression: boom\(\$item\)/s);
  });

  it("locates a failing heading at the article item itself, not its descended body", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ article: { no: "1", heading: "{{ boom($x) }}", body: [{ paragraph: "p" }] } }],
    };
    try {
      await assembleTree(template, { helpers: { boom } });
      throw new Error("expected an ExpressionError");
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      expect(error.location?.path).toBe("body[0]");
    }
  });

  it("names the list group and item indices for a failure inside a list", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ numberedList: [[{ paragraph: "ok" }], [{ paragraph: "{{ boom($x) }}" }]] }],
    };
    await expect(assembleTree(template, { helpers: { boom } })).rejects.toThrow(
      /at body\[0\]\[1\]\[0\].*expression: boom\(\$x\)/s,
    );
  });
});
