import { describe, it, expect } from "vitest";
import { interpolate } from "../src/core/interpolate";
import { defaultHelpers } from "../src/core/helpers";

describe("interpolate", () => {
  it("returns text without tokens unchanged", () => {
    expect(interpolate("Just literal text.", { scope: {}, helpers: {} })).toBe("Just literal text.");
  });

  it("substitutes payload paths", () => {
    expect(interpolate("Hi {{ $name }}!", { scope: { name: "Bob" }, helpers: {} })).toBe("Hi Bob!");
  });

  it("substitutes helper calls", () => {
    const text = interpolate("{{ formatCurrency($amount, $ccy) }}", {
      scope: { amount: 1000, ccy: "EUR" },
      helpers: defaultHelpers,
    });
    expect(text).toBe("EUR 1000.00");
  });
});
