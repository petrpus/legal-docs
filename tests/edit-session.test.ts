import { describe, it, expect, vi } from "vitest";
import type { DocumentTree } from "../src/core/document-tree";
import { EditError, EditSetValidationError, type EditOp } from "../src/core/edit";
import { createEditSession, EditSessionError } from "../src/edit";

const baseTree: DocumentTree = {
  body: [
    { kind: "title", text: "PLEDGE AGREEMENT" },
    { kind: "paragraph", text: "The price is 100 CZK." },
    { kind: "article", no: "1", level: 1, heading: "Definitions", body: [{ kind: "paragraph", text: "As defined below." }] },
    { kind: "bulletList", items: [[{ kind: "paragraph", text: "First bullet." }]] },
  ],
  header: { left: "Pledge Agreement", right: "Confidential" },
  footer: { center: "Page 1" },
  page: { size: "A4", orientation: "portrait" },
};

const BASE_ID = "a356ab1f231ec2ba";

/** A `Snapshot`-shaped base: the session only ever needs the id and the frozen tree. */
function baseSnapshot(): { id: string; tree: DocumentTree } {
  return { id: BASE_ID, tree: structuredClone(baseTree) };
}

const setTitle: EditOp = { op: "setText", path: ["body", 0, "text"], value: "PLEDGE AGREEMENT (AMENDED)" };
const setPrice: EditOp = { op: "setText", path: ["body", 1, "text"], value: "The price is 120 CZK." };
const removeBullet: EditOp = { op: "removeListItem", path: ["body", 3, "items", 0] };

const fixedNow = () => "2026-01-01T00:00:00.000Z";

describe("createEditSession — linear history", () => {
  it("applies an op, exposing the new tree while the base stays untouched", () => {
    const session = createEditSession({ base: baseSnapshot() });
    expect(session.dirty).toBe(false);
    expect(session.cursor).toBe(0);

    const result = session.apply(setTitle);

    expect(result.ok).toBe(true);
    expect(session.tree.body[0]).toMatchObject({ text: "PLEDGE AGREEMENT (AMENDED)" });
    expect(session.base.body[0]).toMatchObject({ text: "PLEDGE AGREEMENT" });
    expect(session.cursor).toBe(1);
    expect(session.ops).toEqual([setTitle]);
    expect(session.dirty).toBe(true);
  });

  it("undoes and redoes, restoring the very same memoized tree object", () => {
    const session = createEditSession({ base: baseSnapshot() });
    const atBase = session.tree;
    session.apply(setTitle);
    const edited = session.tree;

    expect(session.canUndo).toBe(true);
    expect(session.canRedo).toBe(false);
    expect(session.undo()).toBe(true);
    expect(session.tree).toBe(atBase);
    expect(session.cursor).toBe(0);
    expect(session.dirty).toBe(false);
    expect(session.canRedo).toBe(true);

    expect(session.redo()).toBe(true);
    // Memoized: redo replays no op, it re-reads the tree the op already produced.
    expect(session.tree).toBe(edited);
    expect(session.cursor).toBe(1);
  });

  it("refuses to undo past the base or to redo past the log, leaving the tree reference alone", () => {
    const session = createEditSession({ base: baseSnapshot() });
    const atBase = session.tree;

    expect(session.undo()).toBe(false);
    expect(session.redo()).toBe(false);
    expect(session.canUndo).toBe(false);
    expect(session.canRedo).toBe(false);
    expect(session.tree).toBe(atBase);
  });

  it("truncates the redo tail when an op is applied after an undo", () => {
    const session = createEditSession({ base: baseSnapshot() });
    session.apply(setTitle);
    session.apply(setPrice);
    session.undo();

    session.apply(removeBullet);

    expect(session.ops).toEqual([setTitle, removeBullet]);
    expect(session.cursor).toBe(2);
    expect(session.canRedo).toBe(false);
    expect(session.tree.body[1]).toMatchObject({ text: "The price is 100 CZK." });
    expect(session.tree.body[3]).toMatchObject({ kind: "bulletList", items: [] });
  });

  it("keeps its own copy of an op, so a caller mutating the op afterwards cannot rewrite history", () => {
    const session = createEditSession({ base: baseSnapshot() });
    const op: EditOp = { op: "setText", path: ["body", 0, "text"], value: "FIRST" };
    session.apply(op);

    op.path = ["body", 1, "text"];

    expect(session.ops[0]).toEqual({ op: "setText", path: ["body", 0, "text"], value: "FIRST" });
  });
});

describe("createEditSession — rejected ops", () => {
  it("returns a typed error and leaves the tree untouched", () => {
    const session = createEditSession({ base: baseSnapshot() });
    session.apply(setTitle);
    const before = session.tree;

    const result = session.apply({ op: "setText", path: ["body", 99, "text"], value: "nowhere" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error).toBeInstanceOf(EditError);
    expect(result.error.reason).toBe("out-of-range");
    expect(result.error.opIndex).toBe(1);
    expect(session.tree).toBe(before);
    expect(session.cursor).toBe(1);
    expect(session.ops).toEqual([setTitle]);
  });

  it("rejects an edit the editability table freezes", () => {
    const session = createEditSession({ base: baseSnapshot() });

    const result = session.apply({ op: "setText", path: ["body", 2, "no"], value: "9" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.reason).toBe("not-editable");
    expect(session.dirty).toBe(false);
  });

  it("throws for a malformed op rather than reporting it as a rejection", () => {
    const session = createEditSession({ base: baseSnapshot() });

    expect(() => session.apply({ op: "setText", path: ["body", 0, "text"], value: 42 } as unknown as EditOp)).toThrow(
      EditSetValidationError,
    );
    expect(() => session.apply({ op: "nope" } as unknown as EditOp)).toThrow(EditSetValidationError);
    expect(session.cursor).toBe(0);
  });
});

describe("createEditSession — starting from a base", () => {
  it("adopts the base Snapshot's id", () => {
    const session = createEditSession({ base: baseSnapshot() });
    session.apply(setTitle);

    expect(session.baseSnapshotId).toBe(BASE_ID);
    expect(session.toEditSet().baseSnapshotId).toBe(BASE_ID);
  });

  it("accepts a bare tree, but then cannot produce an Edit set without a base id", () => {
    const session = createEditSession({ base: structuredClone(baseTree) });
    session.apply(setTitle);

    expect(session.baseSnapshotId).toBeUndefined();
    expect(() => session.toEditSet()).toThrow(EditSessionError);

    const identified = createEditSession({ base: structuredClone(baseTree), baseSnapshotId: BASE_ID });
    expect(identified.toEditSet().baseSnapshotId).toBe(BASE_ID);
  });

  it("refuses a base Snapshot that carries no tree", () => {
    expect(() => createEditSession({ base: { id: BASE_ID } })).toThrow(EditSessionError);
  });

  it("refuses a base tree that is not valid", () => {
    expect(() => createEditSession({ base: { body: [{ kind: "nope" }] } as unknown as DocumentTree })).toThrow();
  });

  it("refuses an Edit set built against another Snapshot", () => {
    const editSet = { schemaVersion: 1, baseSnapshotId: "0000000000000000", ops: [setTitle] };

    expect(() => createEditSession({ base: baseSnapshot(), editSet })).toThrow(EditSessionError);
  });
});

describe("createEditSession — resume from an Edit set", () => {
  it("reproduces the tree, the cursor and the Edit set itself", () => {
    const first = createEditSession({ base: baseSnapshot(), author: "Jane Doe", now: fixedNow });
    first.apply(setTitle);
    first.apply(removeBullet);
    const editSet = first.toEditSet();

    const resumed = createEditSession({ base: baseSnapshot(), editSet, now: fixedNow });

    expect(resumed.tree).toEqual(first.tree);
    expect(resumed.cursor).toBe(2);
    expect(resumed.canUndo).toBe(true);
    expect(resumed.canRedo).toBe(false);
    expect(resumed.toEditSet()).toEqual(editSet);
  });

  it("stamps schema version, author and time on the Edit set it produces", () => {
    const session = createEditSession({ base: baseSnapshot(), author: "Jane Doe", note: "price agreed", now: fixedNow });
    session.apply(setTitle);

    expect(session.toEditSet()).toEqual({
      schemaVersion: 1,
      baseSnapshotId: BASE_ID,
      ops: [setTitle],
      author: "Jane Doe",
      at: "2026-01-01T00:00:00.000Z",
      note: "price agreed",
    });
  });

  it("exports only the ops up to the cursor", () => {
    const session = createEditSession({ base: baseSnapshot(), now: fixedNow });
    session.apply(setTitle);
    session.apply(setPrice);
    session.undo();

    expect(session.toEditSet().ops).toEqual([setTitle]);
    // The redo tail is still there — the cursor, not the log, is what the Edit set freezes.
    expect(session.canRedo).toBe(true);
  });

  it("carries an Edit set's comments through untouched", () => {
    const comments = [
      { id: "c1", path: ["body", 0], originalPath: ["body", 0], anchoredAfterOp: 0, text: "check the title" },
    ];
    const editSet = { schemaVersion: 1, baseSnapshotId: BASE_ID, ops: [setTitle], comments };

    const resumed = createEditSession({ base: baseSnapshot(), editSet, now: fixedNow });

    expect(resumed.toEditSet().comments).toEqual(comments);
  });

  it("rejects an Edit set whose ops do not apply", () => {
    const ops: EditOp[] = [{ op: "removeNode", path: ["body", 42] }];
    const editSet = { schemaVersion: 1, baseSnapshotId: BASE_ID, ops };

    expect(() => createEditSession({ base: baseSnapshot(), editSet })).toThrow(EditError);
  });
});

describe("createEditSession — reading and previewing", () => {
  it("reads the node at a path against the current tree", () => {
    const session = createEditSession({ base: baseSnapshot() });
    session.apply(setTitle);

    expect(session.getNode(["body", 0])).toEqual({ kind: "title", text: "PLEDGE AGREEMENT (AMENDED)" });
    // A path that addresses something other than a node, or nothing at all, is simply absent.
    expect(session.getNode(["body", 0, "text"])).toBeUndefined();
    expect(session.getNode(["body", 42])).toBeUndefined();
    expect(session.getNode(["page"])).toBeUndefined();
  });

  it("previews the current tree as HTML addressed by data-path", () => {
    const session = createEditSession({ base: baseSnapshot() });
    session.apply(setTitle);

    const html = session.preview();

    expect(html).toContain("PLEDGE AGREEMENT (AMENDED)");
    expect(html).toContain('data-path="/body/0"');
    expect(session.preview({ emitPaths: false })).not.toContain("data-path");
  });

  it("leaves header, footer and page setup alone while the body is edited", () => {
    const session = createEditSession({ base: baseSnapshot() });
    session.apply(setTitle);

    expect(session.tree.header).toEqual(baseTree.header);
    expect(session.tree.footer).toEqual(baseTree.footer);
    expect(session.tree.page).toEqual(baseTree.page);

    session.apply({ op: "setFurniture", path: ["footer"], value: { center: "Page 1 of 2" } });

    expect(session.tree.footer).toEqual({ center: "Page 1 of 2" });
    expect(session.tree.header).toEqual(baseTree.header);
  });
});

describe("createEditSession — subscribe", () => {
  it("notifies on every state change and stops on unsubscribe", () => {
    const session = createEditSession({ base: baseSnapshot() });
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);

    session.apply(setTitle);
    expect(listener).toHaveBeenCalledTimes(1);

    session.undo();
    session.redo();
    expect(listener).toHaveBeenCalledTimes(3);

    // Nothing changed: a rejected op and a no-op undo/redo are not state changes.
    session.apply({ op: "removeNode", path: ["body", 42] });
    session.redo();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    session.apply(setPrice);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
