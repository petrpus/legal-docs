import { describe, expect, it } from "vitest";
import { classify, mapBody, mapBodyAsync, walkBody } from "../src/core/body-traversal";
import type { BodyItem } from "../src/core/template";

describe("classify", () => {
  it.each([
    [{ title: "T" }, "leaf", "title"],
    [{ paragraph: "P" }, "leaf", "paragraph"],
    [{ clause: "c@v1" }, "leaf", "clause"],
    [{ partyHeader: { party: "$p", roleLabel: "R" } }, "leaf", "partyHeader"],
    [{ keyValueTable: { rows: [] } }, "leaf", "keyValueTable"],
    [{ signatures: { places: [] } }, "leaf", "signatures"],
    [{ custom: { component: "x" } }, "leaf", "custom"],
    [{ article: { no: "1", body: [] } }, "nested", "article"],
    [{ numberedList: [] }, "nested", "numberedList"],
    [{ bulletList: [] }, "nested", "bulletList"],
    [{ alphaList: [] }, "nested", "alphaList"],
    [{ if: "$x", then: [] }, "control", "if"],
    [{ for: { each: "$xs", as: "x" }, body: [] }, "control", "for"],
    [{ include: "part" }, "directive", "include"],
    [{ slot: "s" }, "directive", "slot"],
  ] as [BodyItem, string, string][])("classifies %j as %s/%s", (item, klass, kind) => {
    expect(classify(item)).toMatchObject({ class: klass, kind });
  });

  it("throws the engine's historical message on a value outside the union", () => {
    expect(() => classify({ bogus: true } as unknown as BodyItem)).toThrow(/Unsupported body item/);
  });

  it("exposes an article's body as one labelled sub-body and rebuilds around it", () => {
    const inner: BodyItem = { paragraph: "in" };
    const item: BodyItem = { article: { no: "1", heading: "H", body: [inner] } };
    const classified = classify(item);
    if (classified.class !== "nested") throw new Error("expected nested");
    expect(classified.subBodies).toEqual([{ label: " › article", body: [inner] }]);
    expect(classified.rebuild([[{ title: "new" }]])).toEqual({
      article: { no: "1", heading: "H", body: [{ title: "new" }] },
    });
  });

  it("exposes list groups as indexed sub-bodies and rebuilds them", () => {
    const item: BodyItem = { numberedList: [[{ paragraph: "a" }], [{ paragraph: "b" }]] };
    const classified = classify(item);
    if (classified.class !== "nested") throw new Error("expected nested");
    expect(classified.subBodies.map((sub) => sub.label)).toEqual(["[0]", "[1]"]);
    expect(classified.rebuild([[{ title: "x" }], []])).toEqual({ numberedList: [[{ title: "x" }], []] });
  });

  it("exposes if branches as then/else sub-bodies, omitting an absent else", () => {
    const bare = classify({ if: "$x", then: [{ paragraph: "t" }] });
    if (bare.class !== "control") throw new Error("expected control");
    expect(bare.subBodies.map((sub) => sub.label)).toEqual([" › then"]);
    const rebuiltBare = bare.rebuild([[{ title: "x" }]]);
    expect(rebuiltBare).toEqual({ if: "$x", then: [{ title: "x" }] });
    expect("else" in rebuiltBare).toBe(false);

    const both = classify({ if: "$x", then: [], else: [{ paragraph: "e" }] });
    if (both.class !== "control") throw new Error("expected control");
    expect(both.subBodies.map((sub) => sub.label)).toEqual([" › then", " › else"]);
    expect(both.rebuild([[{ title: "t" }], [{ title: "e" }]])).toEqual({
      if: "$x",
      then: [{ title: "t" }],
      else: [{ title: "e" }],
    });
  });

  it("exposes a for body and rebuilds it", () => {
    const classified = classify({ for: { each: "$xs", as: "x" }, body: [{ paragraph: "b" }] });
    if (classified.class !== "control") throw new Error("expected control");
    expect(classified.subBodies).toEqual([{ label: " › for", body: [{ paragraph: "b" }] }]);
    expect(classified.rebuild([[{ title: "n" }]])).toEqual({
      for: { each: "$xs", as: "x" },
      body: [{ title: "n" }],
    });
  });
});

describe("mapBody", () => {
  const fillSlot =
    (fills: Record<string, BodyItem[]>) =>
    (item: BodyItem): BodyItem[] | undefined =>
      "slot" in item ? (fills[item.slot] ?? []) : undefined;

  it("splices a replacement in place (one item → many, or none)", () => {
    const body: BodyItem[] = [{ title: "T" }, { slot: "a" }, { slot: "gone" }];
    const out = mapBody(body, fillSlot({ a: [{ paragraph: "1" }, { paragraph: "2" }] }));
    expect(out).toEqual([{ title: "T" }, { paragraph: "1" }, { paragraph: "2" }]);
  });

  it("recurses into every nested and control sub-body", () => {
    const body: BodyItem[] = [
      { article: { no: "1", body: [{ slot: "a" }] } },
      { numberedList: [[{ slot: "a" }]] },
      { if: "$x", then: [{ slot: "a" }], else: [{ slot: "a" }] },
      { for: { each: "$xs", as: "x" }, body: [{ slot: "a" }] },
    ];
    const out = mapBody(body, fillSlot({ a: [{ paragraph: "F" }] }));
    expect(out).toEqual([
      { article: { no: "1", body: [{ paragraph: "F" }] } },
      { numberedList: [[{ paragraph: "F" }]] },
      { if: "$x", then: [{ paragraph: "F" }], else: [{ paragraph: "F" }] },
      { for: { each: "$xs", as: "x" }, body: [{ paragraph: "F" }] },
    ]);
  });

  it("treats a replacement as final — it is not re-walked", () => {
    const out = mapBody([{ slot: "a" }], fillSlot({ a: [{ slot: "b" }], b: [{ paragraph: "X" }] }));
    expect(out).toEqual([{ slot: "b" }]);
  });

  it("reports the shared path vocabulary to the callback", () => {
    const seen: string[] = [];
    const body: BodyItem[] = [
      { title: "T" },
      { article: { no: "1", body: [{ paragraph: "a" }] } },
      { bulletList: [[{ paragraph: "g0" }], [{ paragraph: "g1" }]] },
      { if: "$x", then: [{ paragraph: "t" }], else: [{ paragraph: "e" }] },
      { for: { each: "$xs", as: "x" }, body: [{ paragraph: "f" }] },
    ];
    mapBody(body, (_item, path) => {
      seen.push(path);
      return undefined;
    });
    expect(seen).toEqual([
      "body[0]",
      "body[1]",
      "body[1] › article[0]",
      "body[2]",
      "body[2][0][0]",
      "body[2][1][0]",
      "body[3]",
      "body[3] › then[0]",
      "body[3] › else[0]",
      "body[4]",
      "body[4] › for[0]",
    ]);
  });

  it("honours a custom root path", () => {
    const seen: string[] = [];
    mapBody(
      [{ paragraph: "p" }],
      (_item, path) => {
        seen.push(path);
        return undefined;
      },
      "body[0] › part",
    );
    expect(seen).toEqual(["body[0] › part[0]"]);
  });
});

describe("mapBodyAsync", () => {
  it("splices async replacements and recurses like mapBody", async () => {
    const body: BodyItem[] = [{ article: { no: "1", body: [{ include: "part" }] } }];
    const out = await mapBodyAsync(body, async (item) =>
      "include" in item ? [{ paragraph: `from ${item.include}` }] : undefined,
    );
    expect(out).toEqual([{ article: { no: "1", body: [{ paragraph: "from part" }] } }]);
  });
});

describe("walkBody", () => {
  it("visits every item pre-order with the shared path vocabulary", async () => {
    const seen: string[] = [];
    const body: BodyItem[] = [
      { article: { no: "1", body: [{ clause: "c@v1" }] } },
      { if: "$x", then: [{ slot: "s" }] },
    ];
    await walkBody(body, (item, path) => {
      seen.push(`${Object.keys(item)[0]} @ ${path}`);
    });
    expect(seen).toEqual([
      "article @ body[0]",
      "clause @ body[0] › article[0]",
      "if @ body[1]",
      "slot @ body[1] › then[0]",
    ]);
  });

  it("awaits an async visitor sequentially", async () => {
    const seen: string[] = [];
    await walkBody([{ paragraph: "a" }, { paragraph: "b" }], async (item) => {
      await Promise.resolve();
      seen.push("paragraph" in item ? item.paragraph.toString() : "?");
    });
    expect(seen).toEqual(["a", "b"]);
  });
});
