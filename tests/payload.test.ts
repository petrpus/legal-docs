import { describe, it, expect } from "vitest";
import { z } from "zod";
import { validatePayload, PayloadValidationError } from "../src/core/payload";
import { loan } from "../src/core/schema-fragments";

const schema = z.object({ name: z.string().min(1), loan });

const valid = { name: "Alice", loan: { principal: { amount: 1000, currency: "EUR" } } };

describe("validatePayload", () => {
  it("returns the typed data for a valid payload", () => {
    expect(validatePayload(schema, valid)).toEqual(valid);
  });

  it("throws a path-precise error naming a missing top-level field", () => {
    expect(() => validatePayload(schema, { loan: valid.loan })).toThrow(/name/);
  });

  it("throws a path-precise error for a nested field", () => {
    const bad = { name: "Alice", loan: { principal: { amount: "lots", currency: "EUR" } } };
    expect(() => validatePayload(schema, bad)).toThrow(/loan\.principal\.amount/);
  });

  it("attaches structured issues to the error", () => {
    try {
      validatePayload(schema, { name: "" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PayloadValidationError);
      expect((error as PayloadValidationError).issues.length).toBeGreaterThan(0);
    }
  });
});
