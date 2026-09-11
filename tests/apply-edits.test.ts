import { describe, it, expect } from "vitest";
import { allKindsTree } from "./fixtures/all-kinds-tree";
import { applyEdit, applyEdits } from "../src/core/edit/apply";
import { EditError, parseTreePath as p } from "../src/core/edit/tree-path";
import { locate } from "../src/core/edit/locate";
import { assertValidTree } from "../src/core/document-tree-schema";
import type { EditableNode, EditOp } from "../src/core/edit/edit-set";
import type { DocumentNode, DocumentTree } from "../src/core/document-tree";
import type { RichTextV1 } from "../src/core/rich-text";

/**
 * `applyEdits` is the whole editing layer's write path: validate → deep copy → apply on the copy →
 * validate. These tests pin the contract the rest of the feature (edited Snapshots, the session, the
 * demo API) relies on: purity, sequential semantics, and an error that names the op and the path.
 */

/** Freeze a tree all the way down, so any in-place write during apply throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function textAt(tree: DocumentTree, path: string): string | undefined {
  const location = locate(tree, p(path));
  if (location.kind !== "text") throw new Error(`${path} is not a text leaf`);
  return location.value;
}

/**
 * A tree whose body is three named paragraphs — structural ops read as a before/after list of names
 * instead of a wall of node literals. A factory, because the structural tests mutate what they build.
 */
function abcTree(): DocumentTree {
  return {
    body: [
      { kind: "paragraph", text: "A" },
      { kind: "paragraph", text: "B" },
      { kind: "paragraph", text: "C" },
    ],
  };
}

/** A node list as readable labels: a paragraph/title by its text, anything else by its kind. */
function labels(nodes: readonly DocumentNode[]): string[] {
  return nodes.map((node) => (node.kind === "paragraph" || node.kind === "title" ? node.text : node.kind));
}

function nodeAt<K extends DocumentNode["kind"]>(tree: DocumentTree, path: string, kind: K): Extract<DocumentNode, { kind: K }> {
  const location = locate(tree, p(path));
  if (location.kind !== "node" || location.node.kind !== kind) throw new Error(`${path} is not a ${kind} node`);
  return location.node as Extract<DocumentNode, { kind: K }>;
}

/** The EditError `fn` is expected to throw. */
function errorOf(fn: () => unknown): EditError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditError) return error;
    throw error;
  }
  throw new Error("expected an EditError, but nothing was thrown");
}

describe("applyEdits with setText", () => {
  // Every allow-listed string leaf, driven through the public op rather than through `locate`.
  const leaves = [
    "/body/0/text",
    "/body/1/text",
    "/body/3/roleLabel",
    "/body/3/party/name",
    "/body/3/party/idNumber",
    "/body/3/party/address",
    "/body/5/heading",
    "/body/5/body/0/text",
    "/body/5/body/2/items/0/0/text",
    "/body/8/rows/0/label",
    "/body/8/rows/1/value",
    "/body/11/places/0/name",
    "/body/11/places/0/role",
    "/header/left",
    "/footer/center",
  ];

  it.each(leaves)("sets %s", (path) => {
    const edited = applyEdits(allKindsTree, [{ op: "setText", path: p(path), value: "EDITED" }]);
    expect(textAt(edited, path)).toBe("EDITED");
    expect(() => assertValidTree(edited)).not.toThrow();
  });

  it("deletes an optional leaf when the value is null", () => {
    const edited = applyEdits(allKindsTree, [{ op: "setText", path: p("/body/5/heading"), value: null }]);
    const article = edited.body[5] as Record<string, unknown>;
    expect("heading" in article).toBe(false);
    expect(() => assertValidTree(edited)).not.toThrow();
  });

  it("refuses to delete a required leaf", () => {
    const failure = errorOf(() => applyEdits(allKindsTree, [{ op: "setText", path: p("/body/0/text"), value: null }]));
    expect(failure.reason).toBe("invalid-value");
    expect(failure.message).toContain("/body/0/text");
  });

  it("refuses a target that is not a text leaf", () => {
    expect(errorOf(() => applyEdits(allKindsTree, [{ op: "setText", path: p("/body"), value: "x" }])).reason).toBe("wrong-target");
    expect(errorOf(() => applyEdits(allKindsTree, [{ op: "setText", path: p("/body/2/value"), value: "x" }])).reason).toBe("wrong-target");
  });

  it("applies ops sequentially — the last write wins", () => {
    const edited = applyEdits(allKindsTree, [
      { op: "setText", path: p("/body/0/text"), value: "FIRST" },
      { op: "setText", path: p("/body/0/text"), value: "SECOND" },
    ]);
    expect(textAt(edited, "/body/0/text")).toBe("SECOND");
  });

  it("yields a deep-equal tree when an edit is undone by a later op", () => {
    const edited = applyEdits(allKindsTree, [
      { op: "setText", path: p("/body/0/text"), value: "CHANGED" },
      { op: "setText", path: p("/body/0/text"), value: "PLEDGE AGREEMENT" },
    ]);
    expect(edited).toEqual(allKindsTree);
  });

  it("accepts an empty op list", () => {
    expect(applyEdits(allKindsTree, [])).toEqual(allKindsTree);
  });

  it("applies a single op through applyEdit", () => {
    const edited = applyEdit(allKindsTree, { op: "setText", path: p("/body/0/text"), value: "ONE" });
    expect(textAt(edited, "/body/0/text")).toBe("ONE");
  });
});

describe("applyEdits is pure", () => {
  it("never mutates its input", () => {
    const input = deepFreeze(structuredClone(allKindsTree));
    const edited = applyEdits(input, [
      { op: "setText", path: p("/body/0/text"), value: "EDITED" },
      { op: "setText", path: p("/body/5/heading"), value: null },
    ]);
    expect(input).toEqual(allKindsTree);
    expect(edited).not.toEqual(input);
    expect(edited.body).not.toBe(input.body);
  });

  it("leaves the tree unchanged when an op is rejected", () => {
    const input = deepFreeze(structuredClone(allKindsTree));
    expect(() =>
      applyEdits(input, [
        { op: "setText", path: p("/body/0/text"), value: "EDITED" },
        { op: "setText", path: p("/body/5/no"), value: "9" },
      ]),
    ).toThrow(EditError);
    expect(input).toEqual(allKindsTree);
  });

  it("rejects an invalid input tree before touching it", () => {
    const broken = { body: [{ kind: "paragraph" }] };
    expect(() => applyEdits(broken as unknown as DocumentTree, [])).toThrow();
  });
});

describe("the EditError names the failing op", () => {
  it("carries the op index, kind and path", () => {
    const failure = errorOf(() =>
      applyEdits(allKindsTree, [
        { op: "setText", path: p("/body/0/text"), value: "fine" },
        { op: "setText", path: p("/body/9/props"), value: "nope" },
      ]),
    );
    expect(failure.opIndex).toBe(1);
    expect(failure.op).toBe("setText");
    expect(failure.reason).toBe("not-editable");
    expect(failure.path).toEqual(["body", 9, "props"]);
    expect(failure.message).toContain("op 1");
    expect(failure.message).toContain("/body/9/props");
  });

  it("rejects an op that does not match its schema", () => {
    const failure = errorOf(() => applyEdits(allKindsTree, [{ op: "setText", path: p("/body/0/text"), value: 7 } as unknown as EditOp]));
    expect(failure.reason).toBe("invalid-value");
    expect(failure.opIndex).toBe(0);
  });
});

describe("applyEdits with setRichText", () => {
  const value: RichTextV1 = { type: "doc", blocks: [{ type: "paragraph", runs: [{ text: "Replaced." }] }] };

  it("replaces a richText node's whole value", () => {
    const edited = applyEdit(allKindsTree, { op: "setRichText", path: p("/body/2/value"), value });
    expect(nodeAt(edited, "/body/2", "richText").value).toEqual(value);
  });

  it("copies the value rather than aliasing the caller's object", () => {
    const mutable = structuredClone(value);
    const edited = applyEdit(allKindsTree, { op: "setRichText", path: p("/body/2/value"), value: mutable });
    mutable.blocks[0]!.runs[0]!.text = "MUTATED";
    expect(nodeAt(edited, "/body/2", "richText").value.blocks[0]!.runs[0]!.text).toBe("Replaced.");
  });

  it("refuses a target that is not a richText value", () => {
    expect(errorOf(() => applyEdit(allKindsTree, { op: "setRichText", path: p("/body/0/text"), value })).reason).toBe("wrong-target");
    expect(errorOf(() => applyEdit(allKindsTree, { op: "setRichText", path: p("/body"), value })).reason).toBe("wrong-target");
  });

  it("refuses a value that is not RichTextV1", () => {
    const broken = { type: "doc" } as unknown as RichTextV1;
    expect(errorOf(() => applyEdit(allKindsTree, { op: "setRichText", path: p("/body/2/value"), value: broken })).reason).toBe("invalid-value");
  });
});

describe("applyEdits with setStyle", () => {
  it("sets an alignment override", () => {
    const edited = applyEdit(allKindsTree, { op: "setStyle", path: p("/body/1/align"), value: "right" });
    expect(nodeAt(edited, "/body/1", "paragraph").align).toBe("right");
  });

  it("replaces the whole indent object rather than merging into it", () => {
    // The fixture's paragraph carries `{ firstLine: 12, left: 0 }`; a partial value is the new whole.
    const edited = applyEdit(allKindsTree, { op: "setStyle", path: p("/body/1/indent"), value: { left: 24 } });
    expect(nodeAt(edited, "/body/1", "paragraph").indent).toEqual({ left: 24 });
  });

  it("clears an override with null, leaving no undefined key behind", () => {
    const edited = applyEdit(allKindsTree, { op: "setStyle", path: p("/body/0/align"), value: null });
    expect("align" in (edited.body[0] as object)).toBe(false);
    expect(() => assertValidTree(edited)).not.toThrow();
  });

  it("clearing an override that was never set is a no-op", () => {
    const edited = applyEdit(allKindsTree, { op: "setStyle", path: p("/body/0/indent"), value: null });
    expect(edited).toEqual(allKindsTree);
  });

  it("refuses a target that is not a style override", () => {
    expect(errorOf(() => applyEdit(allKindsTree, { op: "setStyle", path: p("/body/0/text"), value: "right" })).reason).toBe("wrong-target");
  });

  it("refuses a value of the wrong shape for the key", () => {
    expect(errorOf(() => applyEdit(allKindsTree, { op: "setStyle", path: p("/body/0/align"), value: { left: 4 } })).reason).toBe("invalid-value");
    expect(errorOf(() => applyEdit(allKindsTree, { op: "setStyle", path: p("/body/1/indent"), value: "right" })).reason).toBe("invalid-value");
  });

  it("refuses an indent the schema rejects", () => {
    const negative = { left: -4 } as unknown as { left: number };
    expect(errorOf(() => applyEdit(allKindsTree, { op: "setStyle", path: p("/body/1/indent"), value: negative })).reason).toBe("invalid-value");
  });
});

describe("applyEdits with replaceNode", () => {
  const node: EditableNode = { kind: "title", text: "REPLACED" };

  it("replaces the node at the path, leaving its siblings alone", () => {
    const edited = applyEdit(abcTree(), { op: "replaceNode", path: p("/body/1"), node });
    expect(labels(edited.body)).toEqual(["A", "REPLACED", "C"]);
  });

  it("copies the replacement rather than aliasing it", () => {
    const mutable: Extract<DocumentNode, { kind: "paragraph" }> = { kind: "paragraph", text: "N" };
    const edited = applyEdit(abcTree(), { op: "replaceNode", path: p("/body/1"), node: mutable });
    mutable.text = "MUTATED";
    expect(labels(edited.body)).toEqual(["A", "N", "C"]);
  });

  it("refuses to replace a custom block — it is opaque (ADR-0005)", () => {
    const failure = errorOf(() => applyEdit(allKindsTree, { op: "replaceNode", path: p("/body/9"), node }));
    expect(failure.reason).toBe("not-editable");
    expect(failure.message).toContain("/body/9");
  });

  it("refuses a custom block as the replacement", () => {
    const custom = { kind: "custom", component: "qr-code", props: {} } as unknown as EditableNode;
    expect(errorOf(() => applyEdit(allKindsTree, { op: "replaceNode", path: p("/body/1"), node: custom })).reason).toBe("invalid-value");
  });

  it("refuses a target that is not a node", () => {
    expect(errorOf(() => applyEdit(allKindsTree, { op: "replaceNode", path: p("/body"), node })).reason).toBe("wrong-target");
    expect(errorOf(() => applyEdit(allKindsTree, { op: "replaceNode", path: p("/body/0/text"), node })).reason).toBe("wrong-target");
  });

  it("reports an index outside the list", () => {
    expect(errorOf(() => applyEdit(allKindsTree, { op: "replaceNode", path: p("/body/99"), node })).reason).toBe("out-of-range");
  });
});

describe("applyEdits with insertNode", () => {
  const node: EditableNode = { kind: "paragraph", text: "N" };

  it("inserts before the node currently at the path", () => {
    expect(labels(applyEdit(abcTree(), { op: "insertNode", path: p("/body/0"), node }).body)).toEqual(["N", "A", "B", "C"]);
    expect(labels(applyEdit(abcTree(), { op: "insertNode", path: p("/body/2"), node }).body)).toEqual(["A", "B", "N", "C"]);
  });

  it("appends when the index equals the list length", () => {
    expect(labels(applyEdit(abcTree(), { op: "insertNode", path: p("/body/3"), node }).body)).toEqual(["A", "B", "C", "N"]);
  });

  it("inserts into a nested node list", () => {
    const edited = applyEdit(allKindsTree, { op: "insertNode", path: p("/body/5/body/0"), node });
    expect(labels(nodeAt(edited, "/body/5", "article").body)[0]).toBe("N");
  });

  it("keeps a caller-supplied article number verbatim — numbering is not recomputed", () => {
    const article: EditableNode = { kind: "article", no: "99", level: 1, heading: "Inserted", body: [] };
    const edited = applyEdit(abcTree(), { op: "insertNode", path: p("/body/0"), node: article });
    expect(nodeAt(edited, "/body/0", "article").no).toBe("99");
  });

  it("copies the node rather than aliasing the caller's object", () => {
    const mutable: Extract<DocumentNode, { kind: "paragraph" }> = { kind: "paragraph", text: "N" };
    const edited = applyEdit(abcTree(), { op: "insertNode", path: p("/body/0"), node: mutable });
    mutable.text = "MUTATED";
    expect(labels(edited.body)[0]).toBe("N");
  });

  it("refuses an index past the end of the list", () => {
    expect(errorOf(() => applyEdit(abcTree(), { op: "insertNode", path: p("/body/4"), node })).reason).toBe("out-of-range");
  });

  it("refuses a path that does not end in an index", () => {
    expect(errorOf(() => applyEdit(abcTree(), { op: "insertNode", path: p("/body"), node })).reason).toBe("invalid-path");
  });

  it("refuses a position that is not in a node list", () => {
    // `…/items/0` is a position among list ITEMS — `insertListItem` territory, not a node insert.
    expect(errorOf(() => applyEdit(allKindsTree, { op: "insertNode", path: p("/body/6/items/0"), node })).reason).toBe("wrong-target");
  });

  it("refuses a custom block", () => {
    const custom = { kind: "custom", component: "qr-code", props: {} } as unknown as EditableNode;
    expect(errorOf(() => applyEdit(abcTree(), { op: "insertNode", path: p("/body/0"), node: custom })).reason).toBe("invalid-value");
  });
});

describe("applyEdits with removeNode", () => {
  it("removes the node at the path and pulls the rest back", () => {
    expect(labels(applyEdit(abcTree(), { op: "removeNode", path: p("/body/1") }).body)).toEqual(["A", "C"]);
  });

  it("removes a custom block — removal is kind-agnostic", () => {
    const edited = applyEdit(allKindsTree, { op: "removeNode", path: p("/body/9") });
    expect(edited.body).toHaveLength(allKindsTree.body.length - 1);
    expect(edited.body[9]).toEqual(allKindsTree.body[10]);
  });

  it("leaves an empty but valid body when the last node goes", () => {
    const edited = applyEdits({ body: [{ kind: "paragraph", text: "only" }] }, [{ op: "removeNode", path: p("/body/0") }]);
    expect(edited.body).toEqual([]);
  });

  it("refuses a target that is not a node", () => {
    expect(errorOf(() => applyEdit(allKindsTree, { op: "removeNode", path: p("/body") })).reason).toBe("wrong-target");
    expect(errorOf(() => applyEdit(allKindsTree, { op: "removeNode", path: p("/body/0/text") })).reason).toBe("wrong-target");
  });

  it("reports an index outside the list", () => {
    expect(errorOf(() => applyEdit(abcTree(), { op: "removeNode", path: p("/body/3") })).reason).toBe("out-of-range");
  });
});

describe("applyEdits with moveNode", () => {
  it("reads `to` against the tree AFTER the removal (RFC 6902 move)", () => {
    // Removing A leaves [B, C]; index 2 in that list appends.
    expect(labels(applyEdit(abcTree(), { op: "moveNode", from: p("/body/0"), to: p("/body/2") }).body)).toEqual(["B", "C", "A"]);
    expect(labels(applyEdit(abcTree(), { op: "moveNode", from: p("/body/0"), to: p("/body/1") }).body)).toEqual(["B", "A", "C"]);
  });

  it("moving a node onto its own position is a no-op", () => {
    expect(applyEdit(abcTree(), { op: "moveNode", from: p("/body/1"), to: p("/body/1") })).toEqual(abcTree());
  });

  it("moves a node into another list", () => {
    // The title is `/body/0`; once it is removed the article sits at `/body/4`, and that is the tree
    // the destination is read against.
    const edited = applyEdit(allKindsTree, { op: "moveNode", from: p("/body/0"), to: p("/body/4/body/0") });
    expect(edited.body).toHaveLength(allKindsTree.body.length - 1);
    expect(nodeAt(edited, "/body/4", "article").body[0]).toEqual(allKindsTree.body[0]);
  });

  it("moves a custom block — moving is kind-agnostic", () => {
    const edited = applyEdit(allKindsTree, { op: "moveNode", from: p("/body/9"), to: p("/body/0") });
    expect(edited.body[0]).toEqual(allKindsTree.body[9]);
  });

  it("refuses a destination inside the moved subtree", () => {
    // After the article is removed the body is empty, so its own body is no longer addressable.
    const nested: DocumentTree = { body: [{ kind: "article", no: "1", level: 1, body: [{ kind: "paragraph", text: "inner" }] }] };
    const failure = errorOf(() => applyEdit(nested, { op: "moveNode", from: p("/body/0"), to: p("/body/0/body/0") }));
    expect(failure.op).toBe("moveNode");
    expect(failure.reason).toBe("out-of-range");
    expect(nested.body).toHaveLength(1);
  });

  it("refuses a source that is not a node, and a destination that is not a position", () => {
    expect(errorOf(() => applyEdit(abcTree(), { op: "moveNode", from: p("/body"), to: p("/body/0") })).reason).toBe("wrong-target");
    expect(errorOf(() => applyEdit(abcTree(), { op: "moveNode", from: p("/body/0"), to: p("/body/0/text") })).reason).toBe("invalid-path");
  });
});

describe("applyEdits with insertListItem and removeListItem", () => {
  /** The fixture's bullet list at `/body/6` — two items, each a one-node list. */
  const items = (tree: DocumentTree) => nodeAt(tree, "/body/6", "bulletList").items;
  const item: EditableNode[] = [{ kind: "paragraph", text: "N" }];

  it("inserts an item before the index", () => {
    const edited = applyEdit(allKindsTree, { op: "insertListItem", path: p("/body/6/items/0"), item });
    expect(items(edited)).toHaveLength(3);
    expect(labels(items(edited)[0]!)).toEqual(["N"]);
  });

  it("appends when the index equals the item count", () => {
    const edited = applyEdit(allKindsTree, { op: "insertListItem", path: p("/body/6/items/2"), item });
    expect(labels(items(edited)[2]!)).toEqual(["N"]);
  });

  it("accepts an empty item", () => {
    const edited = applyEdit(allKindsTree, { op: "insertListItem", path: p("/body/6/items/0"), item: [] });
    expect(items(edited)[0]).toEqual([]);
    expect(() => assertValidTree(edited)).not.toThrow();
  });

  it("removes an item, and removing the last one leaves an empty list", () => {
    const one = applyEdit(allKindsTree, { op: "removeListItem", path: p("/body/6/items/0") });
    expect(items(one)).toHaveLength(1);
    const none = applyEdits(one, [{ op: "removeListItem", path: p("/body/6/items/0") }]);
    expect(items(none)).toEqual([]);
    expect(() => assertValidTree(none)).not.toThrow();
  });

  it("refuses a position that is not among a list's items", () => {
    expect(errorOf(() => applyEdit(allKindsTree, { op: "insertListItem", path: p("/body/0"), item })).reason).toBe("wrong-target");
    expect(errorOf(() => applyEdit(allKindsTree, { op: "removeListItem", path: p("/body/0") })).reason).toBe("wrong-target");
  });

  it("refuses an index past the end", () => {
    expect(errorOf(() => applyEdit(allKindsTree, { op: "insertListItem", path: p("/body/6/items/3"), item })).reason).toBe("out-of-range");
    // An index equal to the count is an append position — nothing to remove there.
    expect(errorOf(() => applyEdit(allKindsTree, { op: "removeListItem", path: p("/body/6/items/2") })).reason).toBe("out-of-range");
  });

  it("refuses a path that does not end in an index", () => {
    expect(errorOf(() => applyEdit(allKindsTree, { op: "insertListItem", path: p("/body/6/items"), item })).reason).toBe("invalid-path");
  });

  it("refuses a custom block inside an inserted item", () => {
    const custom = [{ kind: "custom", component: "qr-code", props: {} }] as unknown as EditableNode[];
    expect(errorOf(() => applyEdit(allKindsTree, { op: "insertListItem", path: p("/body/6/items/0"), item: custom })).reason).toBe("invalid-value");
  });
});

describe("applyEdits with setFurniture", () => {
  it("replaces a whole furniture object", () => {
    const edited = applyEdit(allKindsTree, { op: "setFurniture", path: p("/footer"), value: { left: "Draft" } });
    expect(edited.footer).toEqual({ left: "Draft" });
  });

  it("removes the furniture with null, leaving no undefined key behind", () => {
    const edited = applyEdit(allKindsTree, { op: "setFurniture", path: p("/header"), value: null });
    expect("header" in edited).toBe(false);
    expect(() => assertValidTree(edited)).not.toThrow();
  });

  it("creates furniture on a document that has none", () => {
    const edited = applyEdits({ body: [] }, [{ op: "setFurniture", path: p("/header"), value: { center: "New" } }]);
    expect(edited.header).toEqual({ center: "New" });
  });

  it("refuses a single slot — setFurniture takes the whole object", () => {
    expect(errorOf(() => applyEdit(allKindsTree, { op: "setFurniture", path: p("/header/left"), value: null })).reason).toBe("wrong-target");
    expect(errorOf(() => applyEdit(allKindsTree, { op: "setFurniture", path: p("/body"), value: null })).reason).toBe("wrong-target");
  });

  it("refuses a value that is not a furniture object", () => {
    const broken = { center: 7 } as unknown as { center: string };
    expect(errorOf(() => applyEdit(allKindsTree, { op: "setFurniture", path: p("/footer"), value: broken })).reason).toBe("invalid-value");
  });
});

describe("ops resolve against the tree the previous op left", () => {
  it("shifts a later op's index through an insert", () => {
    const edited = applyEdits(abcTree(), [
      { op: "insertNode", path: p("/body/0"), node: { kind: "paragraph", text: "N" } },
      // `/body/1` now addresses the original first node, not the one just inserted.
      { op: "setText", path: p("/body/1/text"), value: "EDITED" },
    ]);
    expect(labels(edited.body)).toEqual(["N", "EDITED", "B", "C"]);
  });

  it("leaves the tree untouched when a structural op halfway through is rejected", () => {
    const input = deepFreeze(structuredClone(allKindsTree));
    expect(() =>
      applyEdits(input, [
        { op: "removeNode", path: p("/body/0") },
        { op: "moveNode", from: p("/body/99"), to: p("/body/0") },
      ]),
    ).toThrow(EditError);
    expect(input).toEqual(allKindsTree);
  });
});
