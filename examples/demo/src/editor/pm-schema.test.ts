import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { normalizeTree } from "@petrpus/legal-docs/edit";
import type { Align, BlockIndent, DocumentNode, DocumentTree, RichRun } from "@petrpus/legal-docs/edit";
import { documentSchema, pmDocToTree, treeToPmDoc } from "./pm-schema";

/**
 * The losslessness proof for the editor mapping (#158): for any tree the library can hold, loading it
 * into the ProseMirror model and reading it back yields exactly `normalizeTree` of it. Anything the
 * mapping drops, reorders or invents fails this property — which is what lets the WYSIWYG shell (#159)
 * hand the result straight back to the edit session.
 */

const MAX_ARTICLE_LEVEL = 3;

const text = fc.string({ maxLength: 12 });

const align = fc.constantFrom<Align>("left", "center", "right", "justify");

const indent = fc.oneof<fc.Arbitrary<BlockIndent>[]>(
  fc.constant({}),
  fc.record({ firstLine: fc.integer({ min: -20, max: 40 }) }),
  fc.record({ left: fc.integer({ min: -20, max: 40 }) }),
  fc.record({ firstLine: fc.integer({ min: -20, max: 40 }), left: fc.integer({ min: -20, max: 40 }) }),
);

/** Marks are generated unordered, duplicated and empty — `normalizeTree` owns the canonical form. */
const marks = fc.constantFrom<RichRun["marks"]>(
  undefined,
  [],
  ["bold"],
  ["italic"],
  ["bold", "italic"],
  ["italic", "bold"],
  ["bold", "bold"],
);

// An empty run is deliberately frequent: ProseMirror has no empty text node, so it is the shape the
// mapping has to collapse (and re-invent for an empty paragraph).
const run: fc.Arbitrary<RichRun> = fc
  .tuple(fc.oneof(fc.constant(""), text), marks)
  .map(([value, m]) => (m === undefined ? { text: value } : { text: value, marks: m }));

const richText: fc.Arbitrary<Extract<DocumentNode, { kind: "richText" }>> = fc
  .array(fc.array(run, { maxLength: 4 }), { maxLength: 3 })
  .map((blocks) => ({
    kind: "richText",
    value: { type: "doc", blocks: blocks.map((runs) => ({ type: "paragraph", runs })) },
  }));

function styled(kind: "title" | "paragraph"): fc.Arbitrary<DocumentNode> {
  return fc
    .tuple(text, fc.option(align, { nil: undefined }), fc.option(indent, { nil: undefined }))
    .map(([value, a, i]) => ({
      kind,
      text: value,
      ...(a === undefined ? {} : { align: a }),
      ...(i === undefined ? {} : { indent: i }),
    }));
}

const partyHeader: fc.Arbitrary<DocumentNode> = fc
  .record(
    {
      name: text,
      kind: fc.constantFrom("person" as const, "company" as const),
      idNumber: text,
      address: text,
    },
    { requiredKeys: ["name"] },
  )
  .chain((party) => text.map((roleLabel) => ({ kind: "partyHeader", party, roleLabel })));

const keyValueTable: fc.Arbitrary<DocumentNode> = fc
  .array(fc.record({ label: text, value: text }), { maxLength: 3 })
  .map((rows) => ({ kind: "keyValueTable", rows }));

const signatures: fc.Arbitrary<DocumentNode> = fc
  .array(fc.record({ name: text, role: text }, { requiredKeys: ["name"] }), { maxLength: 3 })
  .map((places) => ({ kind: "signatures", places }));

const custom: fc.Arbitrary<DocumentNode> = fc
  .tuple(fc.constantFrom("qr-code", "page-break"), fc.oneof(fc.constant(undefined), fc.jsonValue()))
  .map(([component, props]) => ({ kind: "custom", component, props }));

const leaf = fc.oneof(styled("title"), styled("paragraph"), richText, partyHeader, keyValueTable, signatures, custom);

/**
 * Two counters, because they are two different things: `level` is the article level the node would be
 * authored with (an article inside a *list item* inside an article is still one level down, and it is
 * exactly what `pmDocToTree` recomputes), while `budget` bounds the structural nesting so the
 * arbitraries — built eagerly — terminate.
 */
const MAX_NESTING = 3;

function nodeArb(level: number, budget: number): fc.Arbitrary<DocumentNode> {
  if (budget <= 0) return leaf;
  if (level > MAX_ARTICLE_LEVEL) return fc.oneof(leaf, listArb(level, budget));
  return fc.oneof(leaf, listArb(level, budget), articleArb(level, budget));
}

function bodyArb(level: number, budget: number): fc.Arbitrary<DocumentNode[]> {
  return fc.array(nodeArb(level, budget), { maxLength: budget >= MAX_NESTING ? 4 : 2 });
}

function articleArb(level: number, budget: number): fc.Arbitrary<DocumentNode> {
  return fc
    .tuple(text, fc.option(text, { nil: undefined }), bodyArb(level + 1, budget - 1))
    .map(([no, heading, body]) => ({
      kind: "article",
      no,
      level,
      ...(heading === undefined ? {} : { heading }),
      body,
    }));
}

function listArb(level: number, budget: number): fc.Arbitrary<DocumentNode> {
  return fc
    .tuple(
      fc.constantFrom("numberedList" as const, "bulletList" as const, "alphaList" as const),
      // Lists of lists, and empty items, come out of nesting the same body arbitrary.
      fc.array(bodyArb(level, budget - 1), { maxLength: 3 }),
    )
    .map(([kind, items]) => ({ kind, items }));
}

const treeArb: fc.Arbitrary<DocumentTree> = fc
  .tuple(
    bodyArb(1, MAX_NESTING),
    fc.option(fc.record({ left: text, center: text, right: text }, { requiredKeys: [] }), { nil: undefined }),
    fc.option(fc.record({ center: text }, { requiredKeys: [] }), { nil: undefined }),
    fc.option(fc.constant({ size: "A4" as const, orientation: "portrait" as const }), { nil: undefined }),
  )
  .map(([body, header, footer, page]) => ({
    body,
    ...(header === undefined ? {} : { header }),
    ...(footer === undefined ? {} : { footer }),
    ...(page === undefined ? {} : { page }),
  }));

describe("pm-schema round trip", () => {
  it("declares every Core node kind", () => {
    for (const name of ["title", "paragraph", "richText", "article", "list", "partyHeader", "keyValueTable", "signatures", "custom"]) {
      expect(documentSchema.nodes[name]).toBeDefined();
    }
    expect(Object.keys(documentSchema.marks)).toStrictEqual(["bold", "italic"]);
  });

  it("pmDocToTree(treeToPmDoc(t)) equals normalizeTree(t)", () => {
    fc.assert(
      fc.property(treeArb, (tree) => {
        expect(pmDocToTree(treeToPmDoc(tree))).toStrictEqual(normalizeTree(tree));
      }),
      { numRuns: 300 },
    );
  });

  it("recomputes every article level from its depth", () => {
    fc.assert(
      fc.property(treeArb, (tree) => {
        const levels = levelsOf(pmDocToTree(treeToPmDoc(tree)).body, 1);
        // The level the mapping derived is the depth it found the article at …
        expect(levels.every(([level, depth]) => level === depth)).toBe(true);
        // … and it is the level the tree was authored with.
        expect(levels).toStrictEqual(levelsOf(tree.body, 1));
      }),
      { numRuns: 200 },
    );
  });

  it("is idempotent on the normal form", () => {
    fc.assert(
      fc.property(treeArb, (tree) => {
        const once = pmDocToTree(treeToPmDoc(tree));
        expect(pmDocToTree(treeToPmDoc(once))).toStrictEqual(once);
      }),
      { numRuns: 200 },
    );
  });
});

/** Every article level in document order, paired with the depth it sits at — must agree everywhere. */
function levelsOf(body: DocumentNode[], depth: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const node of body) {
    if (node.kind === "article") {
      out.push([node.level, depth]);
      out.push(...levelsOf(node.body, depth + 1));
    } else if (node.kind === "numberedList" || node.kind === "bulletList" || node.kind === "alphaList") {
      for (const item of node.items) out.push(...levelsOf(item, depth));
    }
  }
  return out;
}
