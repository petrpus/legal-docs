import { describe, it, expect } from "vitest";
import { assembleTree, type ClauseResolver } from "../src/core/engine";
import type { Template } from "../src/core/template";
import type { Clause } from "../src/core/clause";

describe("assembleTree", () => {
  it("maps title and paragraph body items to document nodes", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ title: "Hello" }, { paragraph: "World" }],
    };

    expect(await assembleTree(template)).toEqual([
      { kind: "title", text: "Hello" },
      { kind: "paragraph", text: "World" },
    ]);
  });

  it("rejects an unsupported body item", async () => {
    const template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ wat: "x" }],
    } as unknown as Template;

    await expect(assembleTree(template)).rejects.toThrow(/Unsupported body item/);
  });

  it("rejects an unfilled slot reaching assembly", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ slot: "intro" }],
    };

    await expect(assembleTree(template)).rejects.toThrow(
      /Unfilled slot "intro" reached tree assembly — compose a Variant first/,
    );
  });

  it("rejects an unexpanded include reaching assembly", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ include: "greeting-block" }],
    };

    await expect(assembleTree(template)).rejects.toThrow(
      /Unexpanded include "greeting-block" reached tree assembly — expand Includes first/,
    );
  });

  it("resolves a clause, binds vars, and renders its rich text", async () => {
    const clause: Clause = {
      clause: "counterparts",
      version: 2,
      locale: "en",
      vars: { count: { type: "integer", min: 1 } },
      text: "Signed in **{{ $count }}** copies.",
    };
    const clauses: ClauseResolver = async (ref) => {
      expect(ref).toBe("counterparts@latest");
      return clause;
    };
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ clause: "counterparts@latest", vars: { count: "$n" } }],
    };

    const tree = await assembleTree(template, { scope: { n: 3 }, clauses });
    expect(tree).toEqual([
      {
        kind: "richText",
        value: {
          type: "doc",
          blocks: [
            {
              type: "paragraph",
              runs: [
                { text: "Signed in " },
                { text: "3", marks: ["bold"] },
                { text: " copies." },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("validates bound vars against the clause mini-schema", async () => {
    const clauses: ClauseResolver = async () => ({
      clause: "c",
      version: 1,
      locale: "en",
      vars: { count: { type: "integer", min: 1 } },
      text: "{{ $count }}",
    });
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ clause: "c", vars: { count: 0 } }],
    };

    await expect(assembleTree(template, { clauses })).rejects.toThrow(/count: must be >= 1/);
  });

  it("rejects a clause item when no clause resolver is provided", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ clause: "counterparts@latest" }],
    };

    await expect(assembleTree(template)).rejects.toThrow(/No clause resolver/);
  });

  it("assembles a nested article with computed levels and an interpolated heading", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [
        {
          article: {
            no: "1.",
            heading: "Section {{ $x }}",
            body: [
              { paragraph: "body" },
              { article: { no: "1.1.", body: [{ paragraph: "nested" }] } },
            ],
          },
        },
      ],
    };

    expect(await assembleTree(template, { scope: { x: "A" } })).toEqual([
      {
        kind: "article",
        no: "1.",
        level: 1,
        heading: "Section A",
        body: [
          { kind: "paragraph", text: "body" },
          { kind: "article", no: "1.1.", level: 2, body: [{ kind: "paragraph", text: "nested" }] },
        ],
      },
    ]);
  });

  it("assembles list items into arrays of nodes", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ numberedList: [[{ paragraph: "a" }], [{ paragraph: "b" }]] }],
    };

    expect(await assembleTree(template)).toEqual([
      {
        kind: "numberedList",
        items: [[{ kind: "paragraph", text: "a" }], [{ kind: "paragraph", text: "b" }]],
      },
    ]);
  });

  it.each(["numberedList", "bulletList", "alphaList"] as const)(
    "assembles %s into the matching node kind",
    async (kind) => {
      const template = {
        template: "t",
        version: 1,
        locale: "en",
        body: [{ [kind]: [[{ paragraph: "x" }]] }],
      } as unknown as Template;

      const tree = await assembleTree(template);
      expect(tree[0]).toEqual({ kind, items: [[{ kind: "paragraph", text: "x" }]] });
    },
  );

  it("caps the article level at 3 however deep the nesting", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [
        {
          article: {
            no: "1.",
            body: [
              { article: { no: "1.1.", body: [{ article: { no: "1.1.1.", body: [{ article: { no: "x", body: [] } }] } }] } },
            ],
          },
        },
      ],
    };

    const tree = await assembleTree(template);
    const levels: number[] = [];
    const walk = (nodes: typeof tree): void => {
      for (const node of nodes) {
        if (node.kind === "article") {
          levels.push(node.level);
          walk(node.body);
        }
      }
    };
    walk(tree);
    expect(levels).toEqual([1, 2, 3, 3]);
  });

  it("omits heading when an article has none", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ article: { no: "1.", body: [{ paragraph: "x" }] } }],
    };

    expect(await assembleTree(template)).toEqual([
      { kind: "article", no: "1.", level: 1, body: [{ kind: "paragraph", text: "x" }] },
    ]);
  });

  it("resolves a partyHeader from the payload and validates it", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ partyHeader: { party: "$lender", roleLabel: "Lender" } }],
    };
    const scope = { lender: { name: "Acme Bank", kind: "company", idNumber: "12345678" } };

    expect(await assembleTree(template, { scope })).toEqual([
      {
        kind: "partyHeader",
        roleLabel: "Lender",
        party: { name: "Acme Bank", kind: "company", idNumber: "12345678" },
      },
    ]);
  });

  it("rejects a partyHeader whose party is malformed", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ partyHeader: { party: "$lender", roleLabel: "Lender" } }],
    };

    await expect(assembleTree(template, { scope: { lender: { kind: "company" } } })).rejects.toThrow(
      /name/,
    );
  });

  it("builds keyValueTable rows literally with interpolation", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ keyValueTable: { rows: [{ label: "Name", value: "{{ $who }}" }] } }],
    };

    expect(await assembleTree(template, { scope: { who: "Jane" } })).toEqual([
      { kind: "keyValueTable", rows: [{ label: "Name", value: "Jane" }] },
    ]);
  });

  it("builds keyValueTable rows from a whitelisted row-builder helper", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ keyValueTable: { rows: { fn: "buildRows", args: ["$loan"] } } }],
    };
    const helpers = {
      buildRows: (...args: unknown[]) => {
        const loan = args[0] as { amount: number };
        return [{ label: "Amount", value: String(loan.amount) }];
      },
    };

    expect(await assembleTree(template, { scope: { loan: { amount: 1000 } }, helpers })).toEqual([
      { kind: "keyValueTable", rows: [{ label: "Amount", value: "1000" }] },
    ]);
  });

  it("rejects an unknown row-builder helper", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ keyValueTable: { rows: { fn: "missing" } } }],
    };

    await expect(assembleTree(template)).rejects.toThrow(/Unknown row-builder helper: missing/);
  });

  it("rejects malformed row-builder output instead of coercing it", async () => {
    const base = { template: "t", version: 1, locale: "en" } as const;
    const notArray = {
      ...base,
      body: [{ keyValueTable: { rows: { fn: "bad" } } }],
    } as Template;
    const missingValue = {
      ...base,
      body: [{ keyValueTable: { rows: { fn: "rows" } } }],
    } as Template;

    await expect(
      assembleTree(notArray, { helpers: { bad: () => "nope" } }),
    ).rejects.toThrow(/must return an array/);
    await expect(
      assembleTree(missingValue, { helpers: { rows: () => [{ label: "x" }] } }),
    ).rejects.toThrow(/"value" must be a string or number/);
  });

  it("assembles signature places from a party path and an interpolated name", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [
        {
          signatures: {
            places: [
              { party: "$lender", role: "Lender" },
              { name: "{{ $witness }}", role: "Witness" },
            ],
          },
        },
      ],
    };
    const scope = { lender: { name: "Acme Bank" }, witness: "John Watson" };

    expect(await assembleTree(template, { scope })).toEqual([
      {
        kind: "signatures",
        places: [
          { name: "Acme Bank", role: "Lender" },
          { name: "John Watson", role: "Witness" },
        ],
      },
    ]);
  });

  it("omits role for a place without one", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ signatures: { places: [{ name: "Solo" }] } }],
    };

    expect(await assembleTree(template)).toEqual([
      { kind: "signatures", places: [{ name: "Solo" }] },
    ]);
  });

  it("rejects a signature place with neither party nor name", async () => {
    const template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ signatures: { places: [{ role: "Nobody" }] } }],
    } as Template;

    await expect(assembleTree(template)).rejects.toThrow(/needs either `party` or `name`/);
  });

  it("rejects a signature place whose party path is malformed", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ signatures: { places: [{ party: "$lender", role: "Lender" }] } }],
    };

    await expect(assembleTree(template, { scope: { lender: { role: "x" } } })).rejects.toThrow(
      /name/,
    );
  });

  it("includes the then- or else-branch of an if by a direct field read", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ if: "$flag", then: [{ paragraph: "yes" }], else: [{ paragraph: "no" }] }],
    };

    expect(await assembleTree(template, { scope: { flag: true } })).toEqual([
      { kind: "paragraph", text: "yes" },
    ]);
    expect(await assembleTree(template, { scope: { flag: false } })).toEqual([
      { kind: "paragraph", text: "no" },
    ]);
  });

  it("repeats a for body per element with $index and the loop var", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ for: { each: "$xs", as: "x" }, body: [{ paragraph: "{{ $index }}:{{ $x }}" }] }],
    };

    expect(await assembleTree(template, { scope: { xs: ["a", "b"] } })).toEqual([
      { kind: "paragraph", text: "0:a" },
      { kind: "paragraph", text: "1:b" },
    ]);
  });

  it("rejects computation in an if condition (length / arithmetic / calls)", async () => {
    const make = (cond: string): Template => ({
      template: "t",
      version: 1,
      locale: "en",
      body: [{ if: cond, then: [{ paragraph: "x" }] }],
    });

    await expect(assembleTree(make("$xs.length > 0"), { scope: { xs: [1] } })).rejects.toThrow(
      /Derivation/,
    );
    await expect(assembleTree(make("$a + $b == 2"), { scope: { a: 1, b: 1 } })).rejects.toThrow(
      /computation/,
    );
  });

  it("accepts a comparison against a signed numeric literal in an if", async () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ if: "$balance < -1", then: [{ paragraph: "overdrawn" }] }],
    };

    expect(await assembleTree(template, { scope: { balance: -5 } })).toEqual([
      { kind: "paragraph", text: "overdrawn" },
    ]);
  });

  it("rejects a for-each that does not resolve to an array", async () => {
    const template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ for: { each: "$x", as: "i" }, body: [{ paragraph: "y" }] }],
    } as Template;

    await expect(assembleTree(template, { scope: { x: 5 } })).rejects.toThrow(
      /did not resolve to an array/,
    );
  });

  it("resolves a clause reference from a $-expression", async () => {
    const clauses: ClauseResolver = async (ref) => {
      expect(ref).toBe("counterparts@v2");
      return {
        clause: "counterparts",
        version: 2,
        locale: "en",
        vars: {},
        text: "Picked v2.",
      };
    };
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ clause: "$derived.securityClause" }],
    };

    const tree = await assembleTree(template, {
      scope: { derived: { securityClause: "counterparts@v2" } },
      clauses,
    });
    expect(tree[0]).toEqual({
      kind: "richText",
      value: { type: "doc", blocks: [{ type: "paragraph", runs: [{ text: "Picked v2." }] }] },
    });
  });
});
