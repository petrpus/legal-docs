import { describe, it, expect } from "vitest";
import {
  assertValidEditSet,
  EDIT_SET_SCHEMA_VERSION,
  editOpPath,
  EditSetValidationError,
  EDIT_OP_KINDS,
  type Comment,
  type EditOp,
  type EditSet,
} from "../src/core/edit/edit-set";
import { exportEditSetSchema } from "../src/core/json-schema";

/**
 * The Edit set is the persisted artifact of the editing layer: a JSON document carrying the ops a
 * human applied to a base Snapshot's tree. It crosses process boundaries (browser → API → store), so
 * its zod schema — not TypeScript — is what actually guards it.
 */
const comment: Comment = {
  id: "c1",
  path: ["body", 1, "text"],
  originalPath: ["body", 1, "text"],
  anchoredAfterOp: 0,
  text: "Check this date with the client.",
  quote: "Entered into on 1 January 2026.",
  author: "jane@example.test",
  at: "2026-09-11T10:00:00.000Z",
  resolved: false,
};

const editSet: EditSet = {
  schemaVersion: EDIT_SET_SCHEMA_VERSION,
  baseSnapshotId: "a356ab1f231ec2ba",
  ops: [
    { op: "setText", path: ["body", 0, "text"], value: "PLEDGE AGREEMENT (REV. 2)" },
    { op: "setText", path: ["body", 5, "heading"], value: null },
    { op: "setRichText", path: ["body", 2, "value"], value: { type: "doc", blocks: [{ type: "paragraph", runs: [{ text: "New" }] }] } },
    { op: "setStyle", path: ["body", 0, "align"], value: "right" },
    { op: "setStyle", path: ["body", 1, "indent"], value: null },
    { op: "replaceNode", path: ["body", 1], node: { kind: "paragraph", text: "Replaced." } },
    { op: "insertNode", path: ["body", 1], node: { kind: "paragraph", text: "Inserted." } },
    { op: "removeNode", path: ["body", 7] },
    { op: "moveNode", from: ["body", 0], to: ["body", 2] },
    { op: "insertListItem", path: ["body", 6, "items", 0], item: [{ kind: "paragraph", text: "Item." }] },
    { op: "removeListItem", path: ["body", 6, "items", 1] },
    { op: "setFurniture", path: ["footer"], value: { center: "Page" } },
  ],
  comments: [comment],
  author: "jane@example.test",
  at: "2026-09-11T10:00:00.000Z",
  note: "Negotiation round 2",
};

describe("the Edit set schema", () => {
  it("accepts a set carrying every op kind", () => {
    expect(() => assertValidEditSet(editSet)).not.toThrow();
  });

  it("covers every op kind in the fixture above", () => {
    expect(new Set(editSet.ops.map((op) => op.op))).toEqual(new Set(EDIT_OP_KINDS));
  });

  it("round-trips through JSON unchanged", () => {
    const round: unknown = JSON.parse(JSON.stringify(editSet));
    expect(() => assertValidEditSet(round)).not.toThrow();
    expect(round).toEqual(editSet);
  });

  it("accepts an orphaned comment (its anchor was removed)", () => {
    const orphaned: EditSet = { ...editSet, comments: [{ ...comment, path: null }] };
    expect(() => assertValidEditSet(orphaned)).not.toThrow();
  });

  const malformed: [string, unknown][] = [
    ["not an object", "nope"],
    ["a missing baseSnapshotId", { schemaVersion: 1, ops: [] }],
    ["a missing op list", { schemaVersion: 1, baseSnapshotId: "x" }],
    ["an unknown op kind", { schemaVersion: 1, baseSnapshotId: "x", ops: [{ op: "setColour", path: [], value: "red" }] }],
    ["a non-string setText value", { schemaVersion: 1, baseSnapshotId: "x", ops: [{ op: "setText", path: ["body", 0, "text"], value: 7 }] }],
    ["a negative path index", { schemaVersion: 1, baseSnapshotId: "x", ops: [{ op: "removeNode", path: ["body", -1] }] }],
    ["a fractional path index", { schemaVersion: 1, baseSnapshotId: "x", ops: [{ op: "removeNode", path: ["body", 1.5] }] }],
    ["an invalid node", { schemaVersion: 1, baseSnapshotId: "x", ops: [{ op: "insertNode", path: ["body", 0], node: { kind: "wat" } }] }],
    ["a comment without an id", { schemaVersion: 1, baseSnapshotId: "x", ops: [], comments: [{ text: "hi", path: [], originalPath: [], anchoredAfterOp: 0 }] }],
  ];

  it.each(malformed)("rejects %s", (_label, value) => {
    expect(() => assertValidEditSet(value)).toThrow(EditSetValidationError);
  });

  // A `custom` block is opaque to editing (ADR-0005): it may be removed or moved, never authored by
  // an editor, so the two ops that carry a node reject it at the schema boundary.
  it.each(["insertNode", "replaceNode"])("rejects a custom node in %s", (op) => {
    const value = { schemaVersion: 1, baseSnapshotId: "x", ops: [{ op, path: ["body", 0], node: { kind: "custom", component: "qr-code", props: {} } }] };
    expect(() => assertValidEditSet(value)).toThrow(EditSetValidationError);
  });

  it.each(["insertNode", "replaceNode"])("rejects a custom node nested inside the node %s carries", (op) => {
    const node = { kind: "article", no: "9.", level: 1, body: [{ kind: "custom", component: "qr-code", props: {} }] };
    const value = { schemaVersion: 1, baseSnapshotId: "x", ops: [{ op, path: ["body", 0], node }] };
    expect(() => assertValidEditSet(value)).toThrow(EditSetValidationError);
  });

  it("rejects a custom node nested inside an inserted list item", () => {
    const item = [{ kind: "bulletList", items: [[{ kind: "custom", component: "qr-code", props: {} }]] }];
    const value = { schemaVersion: 1, baseSnapshotId: "x", ops: [{ op: "insertListItem", path: ["body", 6, "items", 0], item }] };
    expect(() => assertValidEditSet(value)).toThrow(EditSetValidationError);
  });

  it("reports where the set is malformed", () => {
    try {
      assertValidEditSet({ schemaVersion: 1, baseSnapshotId: "x", ops: [{ op: "setText", path: ["body", 0, "text"], value: 7 }] });
      throw new Error("expected an EditSetValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(EditSetValidationError);
      const failure = error as EditSetValidationError;
      expect(failure.issues[0]?.path).toEqual(["ops", 0, "value"]);
      expect(failure.message).toContain("ops.0.value");
    }
  });
});

describe("editOpPath", () => {
  it("returns the op's target path", () => {
    expect(editOpPath({ op: "setText", path: ["body", 0, "text"], value: "x" })).toEqual(["body", 0, "text"]);
  });

  it("returns the source path of a move — the location the op is reported against", () => {
    const move: EditOp = { op: "moveNode", from: ["body", 0], to: ["body", 2] };
    expect(editOpPath(move)).toEqual(["body", 0]);
  });
});

describe("the Edit set JSON Schema export", () => {
  it("lists every op kind", () => {
    const schema = JSON.stringify(exportEditSetSchema());
    for (const kind of EDIT_OP_KINDS) expect(schema).toContain(`"${kind}"`);
  });
});
