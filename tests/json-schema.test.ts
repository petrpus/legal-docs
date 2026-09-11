import { describe, it, expect } from "vitest";
import { z } from "zod";
import { exportDocumentTreeSchema, exportPayloadSchema, exportPayloadSchemas } from "../src/core/json-schema";
import { DOCUMENT_NODE_KINDS } from "../src/core/document-tree";
import { DOCUMENT_NODE_LIST_SCHEMA_ID } from "../src/core/document-tree-schema";
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

/**
 * The DocumentTree export sits alongside the payload export so an external tool (an editor, a form
 * generator, a validator in another language) can consume the tree contract without depending on zod
 * or on this package's TypeScript types.
 */
describe("exportDocumentTreeSchema", () => {
  it("emits draft-7 by default, with the tree's own top-level shape", () => {
    const js = exportDocumentTreeSchema();
    expect(js.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(js).toMatchObject({
      type: "object",
      properties: { header: { type: "object" }, footer: { type: "object" }, page: { type: "object" } },
    });
    expect(js.required).toEqual(["body"]);
  });

  it("describes all 11 node kinds", () => {
    const source = JSON.stringify(exportDocumentTreeSchema());
    for (const kind of DOCUMENT_NODE_KINDS) expect(source).toContain(`"const":"${kind}"`);
  });

  it("expresses the article/list recursion as a named, $ref'd definition rather than inlining forever", () => {
    const js = exportDocumentTreeSchema();
    // `body`, `article.body` and every list `items` entry all point at the one node-list definition,
    // which is how a recursive structure stays finite.
    const definitions = js.definitions as Record<string, unknown>;
    expect(Object.keys(definitions)).toContain(DOCUMENT_NODE_LIST_SCHEMA_ID);
    const ref = `#/definitions/${DOCUMENT_NODE_LIST_SCHEMA_ID}`;
    expect(js.properties).toMatchObject({ body: { $ref: ref } });
    expect(JSON.stringify(definitions[DOCUMENT_NODE_LIST_SCHEMA_ID])).toContain(ref);
  });

  it("targets draft-2020-12 when requested, hoisting the definition into $defs", () => {
    const js = exportDocumentTreeSchema({ target: "draft-2020-12" });
    expect(js.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(Object.keys(js.$defs as Record<string, unknown>)).toContain(DOCUMENT_NODE_LIST_SCHEMA_ID);
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
