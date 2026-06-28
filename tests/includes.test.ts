import { describe, it, expect } from "vitest";
import { expandIncludes, IncludeError, type IncludeLoader } from "../src/core/includes";
import type { BodyItem, Include } from "../src/core/template";

/** A loader backed by a plain id → Include map; unknown ids reject (as a store would). */
function loaderFor(partials: Record<string, BodyItem[]>): IncludeLoader {
  return async (id) => {
    const body = partials[id];
    if (!body) throw new Error(`no such partial "${id}"`);
    return { id, body } satisfies Include;
  };
}

describe("expandIncludes", () => {
  it("leaves a body without includes untouched", async () => {
    const body: BodyItem[] = [{ title: "Hi" }, { paragraph: "There" }];

    expect(await expandIncludes(body, loaderFor({}))).toEqual(body);
  });

  it("splices a partial's body in place, equal to writing it inline", async () => {
    const partials = {
      "greeting-block": [{ title: "Hello" }, { paragraph: "Welcome" }] as BodyItem[],
    };
    const withInclude: BodyItem[] = [{ paragraph: "Before" }, { include: "greeting-block" }, { paragraph: "After" }];
    const inline: BodyItem[] = [
      { paragraph: "Before" },
      { title: "Hello" },
      { paragraph: "Welcome" },
      { paragraph: "After" },
    ];

    expect(await expandIncludes(withInclude, loaderFor(partials))).toEqual(inline);
  });

  it("resolves transitive includes (a partial may include another)", async () => {
    const partials = {
      outer: [{ paragraph: "outer-top" }, { include: "inner" }] as BodyItem[],
      inner: [{ paragraph: "inner" }] as BodyItem[],
    };

    expect(await expandIncludes([{ include: "outer" }], loaderFor(partials))).toEqual([
      { paragraph: "outer-top" },
      { paragraph: "inner" },
    ]);
  });

  it("expands includes nested inside an article body", async () => {
    const partials = { row: [{ paragraph: "row" }] as BodyItem[] };
    const body: BodyItem[] = [
      { article: { no: "1.", body: [{ include: "row" }] } },
    ];

    expect(await expandIncludes(body, loaderFor(partials))).toEqual([
      { article: { no: "1.", body: [{ paragraph: "row" }] } },
    ]);
  });

  it("expands includes nested inside if/then, else and for", async () => {
    const partials = { frag: [{ paragraph: "frag" }] as BodyItem[] };
    const body: BodyItem[] = [
      { if: "$flag", then: [{ include: "frag" }], else: [{ include: "frag" }] },
      { for: { each: "$items", as: "x" }, body: [{ include: "frag" }] },
    ];

    expect(await expandIncludes(body, loaderFor(partials))).toEqual([
      { if: "$flag", then: [{ paragraph: "frag" }], else: [{ paragraph: "frag" }] },
      { for: { each: "$items", as: "x" }, body: [{ paragraph: "frag" }] },
    ]);
  });

  it("expands includes inside list groups", async () => {
    const partials = { item: [{ paragraph: "li" }] as BodyItem[] };
    const body: BodyItem[] = [{ numberedList: [[{ include: "item" }], [{ paragraph: "plain" }]] }];

    expect(await expandIncludes(body, loaderFor(partials))).toEqual([
      { numberedList: [[{ paragraph: "li" }], [{ paragraph: "plain" }]] },
    ]);
  });

  it("throws a path-bearing IncludeError for an unknown partial", async () => {
    const body: BodyItem[] = [{ paragraph: "x" }, { include: "nope" }];

    const err = await expandIncludes(body, loaderFor({})).catch((e) => e);
    expect(err).toBeInstanceOf(IncludeError);
    expect((err as IncludeError).message).toMatch(/include "nope" does not resolve/);
    expect((err as IncludeError).path).toBe("body[1]");
  });

  it("detects a direct include cycle", async () => {
    const partials = { loop: [{ include: "loop" }] as BodyItem[] };

    const err = await expandIncludes([{ include: "loop" }], loaderFor(partials)).catch((e) => e);
    expect(err).toBeInstanceOf(IncludeError);
    expect((err as IncludeError).message).toMatch(/include cycle: loop → loop/);
  });

  it("detects a transitive include cycle (a → b → a)", async () => {
    const partials = {
      a: [{ include: "b" }] as BodyItem[],
      b: [{ include: "a" }] as BodyItem[],
    };

    const err = await expandIncludes([{ include: "a" }], loaderFor(partials)).catch((e) => e);
    expect(err).toBeInstanceOf(IncludeError);
    expect((err as IncludeError).message).toMatch(/include cycle: a → b → a/);
  });

  it("allows the same partial included twice in sequence (not a cycle)", async () => {
    const partials = { frag: [{ paragraph: "frag" }] as BodyItem[] };

    expect(
      await expandIncludes([{ include: "frag" }, { include: "frag" }], loaderFor(partials)),
    ).toEqual([{ paragraph: "frag" }, { paragraph: "frag" }]);
  });
});
