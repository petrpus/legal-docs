import { describe, it, expect } from "vitest";
import {
  buildSnapshot,
  assertValidSnapshot,
  SnapshotError,
  SNAPSHOT_SCHEMA_VERSION,
  type Snapshot,
  type SnapshotInput,
} from "../src/core/snapshot";
import { buildEditedSnapshot, verifyEditedSnapshot } from "../src/core/edited-snapshot";
import { EditError, EditSetValidationError, EDIT_SET_SCHEMA_VERSION, type EditSet } from "../src/core/edit";

const gen: SnapshotInput = {
  template: "doc",
  version: 1,
  variant: "short",
  locale: "en",
  payload: { who: "Acme" },
  resolved: { who: "Acme", derived: {} },
  pins: [{ ref: "note@latest", clause: "note", version: 1, locale: "en" }],
  tree: {
    body: [
      { kind: "title", text: "NOTE DOCUMENT" },
      { kind: "paragraph", text: "Original note wording." },
    ],
  },
};

const base = buildSnapshot(gen);

function editSet(baseSnapshotId: string, ops: EditSet["ops"], extra: Partial<EditSet> = {}): EditSet {
  return { schemaVersion: EDIT_SET_SCHEMA_VERSION, baseSnapshotId, ops, ...extra };
}

const rewordOps: EditSet["ops"] = [{ op: "setText", path: ["body", 1, "text"], value: "Edited note wording." }];

describe("buildEditedSnapshot", () => {
  it("freezes the edited tree as a tree-mode Snapshot carrying the base's provenance", () => {
    const edited = buildEditedSnapshot(base, editSet(base.id, rewordOps, { author: "jana", note: "reworded" }));

    expect(edited.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(edited.mode).toBe("tree");
    expect(edited.tree?.body[1]).toEqual({ kind: "paragraph", text: "Edited note wording." });
    expect(edited).toMatchObject({ template: "doc", version: 1, variant: "short", locale: "en" });
    // The provenance of the generation the edit started from travels with the edited document.
    expect(edited.payload).toEqual(gen.payload);
    expect(edited.pins).toEqual(gen.pins);
    expect(edited.derivedFrom).toEqual(editSet(base.id, rewordOps, { author: "jana", note: "reworded" }));
  });

  it("never touches the base Snapshot or its tree", () => {
    const before = structuredClone(base);

    buildEditedSnapshot(base, editSet(base.id, rewordOps));

    expect(base).toEqual(before);
  });

  it("computes a deterministic id that differs from the base id", () => {
    const first = buildEditedSnapshot(base, editSet(base.id, rewordOps));
    const again = buildEditedSnapshot(base, editSet(base.id, rewordOps));

    expect(first.id).toMatch(/^[0-9a-f]{16}$/);
    expect(again.id).toBe(first.id);
    expect(first.id).not.toBe(base.id);
  });

  it("gives a differently-edited document a different id", () => {
    const other = buildEditedSnapshot(base, editSet(base.id, [{ op: "setText", path: ["body", 0, "text"], value: "MEMO" }]));

    expect(other.id).not.toBe(buildEditedSnapshot(base, editSet(base.id, rewordOps)).id);
  });

  it("yields a new id even for a no-op Edit set — a derived document is never its base", () => {
    // Deliberate: the id mixes in the base Snapshot id, so "this tree, but derived from that
    // generation" is a distinct audit artifact even when the content came out identical.
    const noop = buildEditedSnapshot(base, editSet(base.id, []));

    expect(noop.tree).toEqual(gen.tree);
    expect(noop.id).not.toBe(base.id);
  });

  it("rejects an Edit set addressing another Snapshot", () => {
    expect(() => buildEditedSnapshot(base, editSet("0000000000000000", rewordOps))).toThrow(SnapshotError);
    expect(() => buildEditedSnapshot(base, editSet("0000000000000000", rewordOps))).toThrow(/0000000000000000/);
  });

  it("rejects a pins-mode base, which has no tree to edit", () => {
    const pinned = buildSnapshot(gen, "pins");

    expect(() => buildEditedSnapshot(pinned, editSet(pinned.id, rewordOps))).toThrow(SnapshotError);
    expect(() => buildEditedSnapshot(pinned, editSet(pinned.id, rewordOps))).toThrow(/pins/);
  });

  it("rejects a malformed Edit set with a path-precise error", () => {
    const malformed = { schemaVersion: EDIT_SET_SCHEMA_VERSION, baseSnapshotId: base.id, ops: [{ op: "setText", path: ["body", 1, "text"] }] };

    expect(() => buildEditedSnapshot(base, malformed as unknown as EditSet)).toThrow(EditSetValidationError);
  });

  it("reports an op that cannot be applied as an EditError naming its index", () => {
    const bad = editSet(base.id, [{ op: "setText", path: ["body", 9, "text"], value: "x" }]);

    expect(() => buildEditedSnapshot(base, bad)).toThrow(EditError);
  });

  it("chains: an edited Snapshot is itself an editable base", () => {
    const first = buildEditedSnapshot(base, editSet(base.id, rewordOps));
    const second = buildEditedSnapshot(first, editSet(first.id, [{ op: "setText", path: ["body", 0, "text"], value: "MEMO" }]));

    expect(second.derivedFrom?.baseSnapshotId).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(second.tree?.body).toEqual([
      { kind: "title", text: "MEMO" },
      { kind: "paragraph", text: "Edited note wording." },
    ]);
    expect(verifyEditedSnapshot(first, second)).toEqual({ ok: true });
  });
});

describe("verifyEditedSnapshot", () => {
  const edited = buildEditedSnapshot(base, editSet(base.id, rewordOps));

  it("re-derives the document from the base and the Edit set", () => {
    expect(verifyEditedSnapshot(base, edited)).toEqual({ ok: true });
  });

  it("detects a tampered tree", () => {
    const tampered = structuredClone(edited);
    tampered.tree = { body: [{ kind: "paragraph", text: "Smuggled clause." }] };

    expect(verifyEditedSnapshot(base, tampered)).toMatchObject({ ok: false, issue: "tree-mismatch" });
  });

  it("detects a tampered id", () => {
    const tampered = { ...edited, id: "deadbeefdeadbeef" };

    expect(verifyEditedSnapshot(base, tampered)).toMatchObject({ ok: false, issue: "id-mismatch" });
  });

  it("detects a swapped base", () => {
    const otherBase = buildSnapshot({ ...gen, payload: { who: "Other" } });

    expect(verifyEditedSnapshot(otherBase, edited)).toMatchObject({ ok: false, issue: "base-mismatch" });
  });

  it("detects tampered provenance the digest cannot see", () => {
    // `pins` is not part of the digest, so only a re-derivation catches a rewritten audit trail.
    const tampered: Snapshot = { ...edited, pins: [] };

    expect(verifyEditedSnapshot(base, tampered)).toMatchObject({ ok: false, issue: "metadata-mismatch" });
  });

  it("reports a Snapshot that is not derived at all", () => {
    expect(verifyEditedSnapshot(base, base)).toMatchObject({ ok: false, issue: "not-derived" });
  });

  it("reports an Edit set that no longer applies", () => {
    const broken = structuredClone(edited);
    broken.derivedFrom = editSet(base.id, [{ op: "setText", path: ["body", 42, "text"], value: "x" }]);

    expect(verifyEditedSnapshot(base, broken)).toMatchObject({ ok: false, issue: "not-applicable" });
  });
});

describe("assertValidSnapshot with derivedFrom", () => {
  it("accepts an edited Snapshot", () => {
    expect(() => assertValidSnapshot(buildEditedSnapshot(base, editSet(base.id, rewordOps)))).not.toThrow();
  });

  it("rejects a malformed derivedFrom", () => {
    const broken = { ...buildEditedSnapshot(base, editSet(base.id, rewordOps)), derivedFrom: { ops: "all of them" } };

    expect(() => assertValidSnapshot(broken)).toThrow(SnapshotError);
    expect(() => assertValidSnapshot(broken)).toThrow(/derivedFrom/);
  });

  it("rejects derivedFrom on a pins-mode Snapshot, which freezes no tree to edit", () => {
    const broken: Snapshot = { ...buildSnapshot(gen, "pins"), derivedFrom: editSet(base.id, rewordOps) };

    expect(() => assertValidSnapshot(broken)).toThrow(SnapshotError);
  });
});
