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
});
