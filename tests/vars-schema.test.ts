import { describe, it, expect } from "vitest";
import { validateVars, VarsValidationError, type VarsSchema } from "../src/core/vars-schema";

describe("validateVars", () => {
  it("accepts values that satisfy the schema", () => {
    const out = validateVars({ count: { type: "integer", min: 1 } }, { count: 3 });
    expect(out).toEqual({ count: 3 });
  });

  it("requires non-optional fields", () => {
    expect(() => validateVars({ count: { type: "integer" } }, {})).toThrow(/count: required/);
  });

  it("skips optional missing fields", () => {
    expect(validateVars({ note: { type: "string", optional: true } }, {})).toEqual({});
  });

  it("enforces type", () => {
    expect(() => validateVars({ count: { type: "integer" } }, { count: "x" })).toThrow(
      VarsValidationError,
    );
  });

  it("enforces integer-ness and bounds", () => {
    expect(() => validateVars({ n: { type: "integer" } }, { n: 1.5 })).toThrow(/integer/);
    expect(() => validateVars({ n: { type: "number", max: 10 } }, { n: 11 })).toThrow(/<= 10/);
  });

  it("fails loudly on an unknown var type from YAML", () => {
    const schema = { n: { type: "int" } } as unknown as VarsSchema;
    expect(() => validateVars(schema, { n: 1 })).toThrow(/unknown var type "int"/);
  });
});
