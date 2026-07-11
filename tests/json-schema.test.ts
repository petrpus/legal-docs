import { describe, it, expect } from "vitest";
import { z } from "zod";
import { exportPayloadSchema, exportPayloadSchemas } from "../src/core/json-schema";
import { money, loan } from "../src/core/schema-fragments";
import { LegalDocsError } from "../src/core/errors";
import type { PayloadSchemaRegistry } from "../src/core/payload";

describe("exportPayloadSchema", () => {
  it("emits draft-7 by default", () => {
    const js = exportPayloadSchema(money);
    expect(js.$schema).toBe("http://json-schema.org/draft-07/schema#");
    // The object shape survives: money is { amount: number, currency: string(len 3) }.
    expect(js).toMatchObject({
      type: "object",
      properties: {
        amount: { type: "number" },
        currency: { type: "string" },
      },
    });
    expect(js.required).toEqual(expect.arrayContaining(["amount", "currency"]));
  });

  it("targets draft-2020-12 when requested", () => {
    const js = exportPayloadSchema(loan, { target: "draft-2020-12" });
    expect(js.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(js).toMatchObject({ type: "object", properties: { principal: expect.any(Object) } });
  });

  it("wraps an unrepresentable schema in a LegalDocsError", () => {
    // A transform has no JSON Schema representation in zod's strict export mode.
    const withTransform = z.string().transform((s) => s.length);
    expect(() => exportPayloadSchema(withTransform)).toThrow(LegalDocsError);
  });
});

describe("exportPayloadSchemas", () => {
  it("converts a whole registry keyed by schema name", () => {
    const registry: PayloadSchemaRegistry = { money, loan };
    const out = exportPayloadSchemas(registry);
    expect(Object.keys(out)).toEqual(["money", "loan"]);
    expect(out.money?.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(out.loan?.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("names the offending key when a schema cannot be converted", () => {
    const registry: PayloadSchemaRegistry = { bad: z.string().transform((s) => s) };
    const err = (() => {
      try {
        exportPayloadSchemas(registry);
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(err.message).toMatch(/schema "bad"/);
    // The message wraps exactly once — no doubled "Cannot export schema … Cannot export schema …".
    expect(err.message.match(/Cannot export schema/g)).toHaveLength(1);
  });
});
