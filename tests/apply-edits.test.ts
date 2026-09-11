import { describe, it, expect } from "vitest";
import { allKindsTree } from "./fixtures/all-kinds-tree";
import { applyEdit, applyEdits } from "../src/core/edit/apply";
import { EditError, parseTreePath as p } from "../src/core/edit/tree-path";
import { locate } from "../src/core/edit/locate";
import { assertValidTree } from "../src/core/document-tree-schema";
import type { EditOp } from "../src/core/edit/edit-set";
import type { DocumentTree } from "../src/core/document-tree";

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

// C4 implements the rest; until then each is rejected by name rather than silently ignored.
describe("the ops that are not implemented yet", () => {
  const pending: EditOp[] = [
    { op: "setRichText", path: ["body", 2, "value"], value: { type: "doc", blocks: [{ type: "paragraph", runs: [{ text: "x" }] }] } },
    { op: "setStyle", path: ["body", 0, "align"], value: "right" },
    { op: "replaceNode", path: ["body", 1], node: { kind: "paragraph", text: "x" } },
    { op: "insertNode", path: ["body", 1], node: { kind: "paragraph", text: "x" } },
    { op: "removeNode", path: ["body", 1] },
    { op: "moveNode", from: ["body", 0], to: ["body", 2] },
    { op: "insertListItem", path: ["body", 6, "items", 0], item: [{ kind: "paragraph", text: "x" }] },
    { op: "removeListItem", path: ["body", 6, "items", 0] },
    { op: "setFurniture", path: ["footer"], value: { center: "x" } },
  ];

  it.each(pending.map((op) => [op.op, op] as const))("rejects %s", (kind, op) => {
    const failure = errorOf(() => applyEdits(allKindsTree, [op]));
    expect(failure.reason).toBe("not-implemented");
    expect(failure.message).toContain(kind);
  });
});
