import { describe, expect, it } from "vitest";
import type { DocumentTree } from "../src/core/document-tree";
import { applyEdits } from "../src/core/edit/apply";
import { diffTree, type TreeChange } from "../src/core/edit/diff-tree";
import type { EditOp } from "../src/core/edit/edit-set";
import { formatTreePath } from "../src/core/edit/tree-path";
import { allKindsTree } from "./fixtures/all-kinds-tree";

/** `["text /body/0/text", …]` — what changed, and where, in document order. */
function summarize(changes: readonly TreeChange[]): string[] {
  return changes.map((change) => `${change.change} ${formatTreePath(change.path)}`);
}

function edit(...ops: EditOp[]): DocumentTree {
  return applyEdits(allKindsTree, ops);
}

describe("diffTree", () => {
  it("reports nothing for two identical trees", () => {
    expect(diffTree(allKindsTree, structuredClone(allKindsTree))).toEqual([]);
  });

  it("reports nothing for a tree that went through apply with no ops", () => {
    expect(diffTree(allKindsTree, applyEdits(allKindsTree, []))).toEqual([]);
  });

  // One row per Edit op kind: the op, and the changes the diff is expected to surface for it. The
  // single-change rows are the contract "one change at the op's path"; the two-change rows record the
  // deliberate exceptions (a node whose kind — or whose frozen identity — changed is remove + add).
  const table: { name: string; ops: EditOp[]; changes: string[] }[] = [
    {
      name: "setText on a title",
      ops: [{ op: "setText", path: ["body", 0, "text"], value: "PLEDGE AGREEMENT (AMENDED)" }],
      changes: ["text /body/0/text"],
    },
    {
      name: "setText on an article heading",
      ops: [{ op: "setText", path: ["body", 5, "heading"], value: "Definitions and interpretation" }],
      changes: ["text /body/5/heading"],
    },
    {
      name: "setText on a party field",
      ops: [{ op: "setText", path: ["body", 3, "party", "name"], value: "Acme Bank SE" }],
      changes: ["text /body/3/party/name"],
    },
    {
      name: "setText deleting an optional party field",
      ops: [{ op: "setText", path: ["body", 3, "party", "address"], value: null }],
      changes: ["text /body/3/party/address"],
    },
    {
      name: "setText on a key-value cell",
      ops: [{ op: "setText", path: ["body", 8, "rows", 1, "value"], value: "5.0 %" }],
      changes: ["text /body/8/rows/1/value"],
    },
    {
      name: "setText adding an absent signature role",
      ops: [{ op: "setText", path: ["body", 11, "places", 1, "role"], value: "Pledgor" }],
      changes: ["text /body/11/places/1/role"],
    },
    {
      name: "setStyle setting an alignment",
      ops: [{ op: "setStyle", path: ["body", 1, "align"], value: "center" }],
      changes: ["attr /body/1/align"],
    },
    {
      name: "setStyle clearing an indent",
      ops: [{ op: "setStyle", path: ["body", 1, "indent"], value: null }],
      changes: ["attr /body/1/indent"],
    },
    {
      name: "setRichText",
      ops: [
        {
          op: "setRichText",
          path: ["body", 2, "value"],
          value: { type: "doc", blocks: [{ type: "paragraph", runs: [{ text: "Plain and rewritten." }] }] },
        },
      ],
      changes: ["richText /body/2/value"],
    },
    {
      name: "replaceNode with a node of the same kind",
      ops: [
        {
          op: "replaceNode",
          path: ["body", 1],
          node: { kind: "paragraph", text: "Entered into on 2 February 2026.", indent: { firstLine: 12, left: 0 } },
        },
      ],
      changes: ["text /body/1/text"],
    },
    {
      name: "replaceNode with a node of another kind",
      ops: [{ op: "replaceNode", path: ["body", 0], node: { kind: "paragraph", text: "PLEDGE AGREEMENT" } }],
      changes: ["removed /body/0", "inserted /body/0"],
    },
    {
      name: "insertNode",
      ops: [{ op: "insertNode", path: ["body", 1], node: { kind: "paragraph", text: "A brand new recital." } }],
      changes: ["inserted /body/1"],
    },
    {
      name: "removeNode",
      ops: [{ op: "removeNode", path: ["body", 1] }],
      changes: ["removed /body/1"],
    },
    {
      name: "moveNode (surfaces as remove + add)",
      ops: [{ op: "moveNode", from: ["body", 0], to: ["body", 2] }],
      changes: ["removed /body/0", "inserted /body/2"],
    },
    {
      name: "insertListItem",
      ops: [
        {
          op: "insertListItem",
          path: ["body", 5, "body", 2, "items", 1],
          item: [{ kind: "paragraph", text: "An inserted numbered item." }],
        },
      ],
      changes: ["insertedItem /body/5/body/2/items/1"],
    },
    {
      name: "removeListItem",
      ops: [{ op: "removeListItem", path: ["body", 5, "body", 2, "items", 0] }],
      changes: ["removedItem /body/5/body/2/items/0"],
    },
    {
      name: "setFurniture changing one slot",
      ops: [
        {
          op: "setFurniture",
          path: ["header"],
          value: { left: "Pledge Agreement", center: "", right: "Internal" },
        },
      ],
      changes: ["text /header/right"],
    },
    {
      name: "setFurniture removing the whole header",
      ops: [{ op: "setFurniture", path: ["header"], value: null }],
      changes: ["text /header/left", "text /header/center", "text /header/right"],
    },
  ];

  for (const row of table) {
    it(`surfaces ${row.name} at the op's path`, () => {
      expect(summarize(diffTree(allKindsTree, edit(...row.ops)))).toEqual(row.changes);
    });
  }

  it("treats a changed custom block as remove + add — its props are opaque", () => {
    const edited = structuredClone(allKindsTree) as DocumentTree;
    const custom = edited.body[9];
    if (custom?.kind !== "custom") throw new Error("fixture drift: /body/9 is no longer a custom block");
    custom.props = { value: "https://example.test/changed", size: 96 };
    expect(summarize(diffTree(allKindsTree, edited))).toEqual(["removed /body/9", "inserted /body/9"]);
  });

  it("treats a changed article number as remove + add — numbering is not editable", () => {
    const edited = structuredClone(allKindsTree) as DocumentTree;
    const article = edited.body[5];
    if (article?.kind !== "article") throw new Error("fixture drift: /body/5 is no longer an article");
    article.no = "2";
    expect(summarize(diffTree(allKindsTree, edited))).toEqual(["removed /body/5", "inserted /body/5"]);
  });

  it("treats a changed article level as remove + add", () => {
    const edited = structuredClone(allKindsTree) as DocumentTree;
    const article = edited.body[5];
    if (article?.kind !== "article") throw new Error("fixture drift: /body/5 is no longer an article");
    article.level = 2;
    expect(summarize(diffTree(allKindsTree, edited))).toEqual(["removed /body/5", "inserted /body/5"]);
  });

  it("carries the before and after values of a changed leaf", () => {
    const [change] = diffTree(allKindsTree, edit({ op: "setText", path: ["body", 0, "text"], value: "AMENDED" }));
    expect(change).toEqual({
      change: "text",
      path: ["body", 0, "text"],
      before: "PLEDGE AGREEMENT",
      after: "AMENDED",
    });
  });

  it("carries the inserted node itself", () => {
    const node = { kind: "paragraph", text: "A brand new recital." } as const;
    const [change] = diffTree(allKindsTree, edit({ op: "insertNode", path: ["body", 1], node }));
    expect(change).toEqual({ change: "inserted", path: ["body", 1], node });
  });

  // A surviving node is reported at its path in the EDITED tree (that is the document a redline shows);
  // only a removal keeps its path in the base tree. Removing `/body/1` therefore moves the article's
  // heading change from `/body/5/heading` to `/body/4/heading`.
  it("reports several changes at once, in document order, against the edited tree", () => {
    const edited = edit(
      { op: "setText", path: ["body", 0, "text"], value: "AMENDED" },
      { op: "setText", path: ["body", 5, "heading"], value: "Definitions and interpretation" },
      { op: "removeNode", path: ["body", 1] },
    );
    expect(summarize(diffTree(allKindsTree, edited))).toEqual([
      "text /body/0/text",
      "removed /body/1",
      "text /body/4/heading",
    ]);
  });

  it("accepts a bare node array as either side", () => {
    expect(diffTree(allKindsTree.body, allKindsTree.body)).toEqual([]);
  });

  it("does not mutate either tree", () => {
    const base = structuredClone(allKindsTree) as DocumentTree;
    const edited = edit({ op: "setText", path: ["body", 0, "text"], value: "AMENDED" });
    const beforeJson = JSON.stringify(base);
    const editedJson = JSON.stringify(edited);
    diffTree(base, edited);
    expect(JSON.stringify(base)).toBe(beforeJson);
    expect(JSON.stringify(edited)).toBe(editedJson);
  });
});
