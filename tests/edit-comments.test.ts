import { describe, it, expect, vi } from "vitest";
import type { DocumentTree } from "../src/core/document-tree";
import { assertValidEditSet, EditError, type EditOp } from "../src/core/edit";
import { createEditSession, EditSessionError } from "../src/edit";

const baseTree: DocumentTree = {
  body: [
    { kind: "title", text: "PLEDGE AGREEMENT" },
    { kind: "paragraph", text: "The price is 100 CZK." },
    {
      kind: "article",
      no: "1",
      level: 1,
      heading: "Definitions",
      body: [{ kind: "paragraph", text: "As defined below." }],
    },
    { kind: "bulletList", items: [[{ kind: "paragraph", text: "First bullet." }]] },
  ],
};

const BASE_ID = "a356ab1f231ec2ba";
const fixedNow = () => "2026-01-01T00:00:00.000Z";

function startSession(extra: Record<string, unknown> = {}) {
  return createEditSession({ base: { id: BASE_ID, tree: structuredClone(baseTree) }, now: fixedNow, ...extra });
}

const insertFirst: EditOp = { op: "insertNode", path: ["body", 0], node: { kind: "paragraph", text: "Preamble." } };
const removePrice: EditOp = { op: "removeNode", path: ["body", 1] };
const rewordPrice: EditOp = { op: "setText", path: ["body", 1, "text"], value: "The price is 120 CZK." };
const setTitle: EditOp = { op: "setText", path: ["body", 0, "text"], value: "PLEDGE AGREEMENT (AMENDED)" };

describe("session comments — anchoring", () => {
  it("anchors a comment to a path, capturing the node's text as the quote", () => {
    const session = startSession();

    const comment = session.addComment({ path: ["body", 1], text: "Check the price." });

    expect(comment).toEqual({
      id: "c1",
      path: ["body", 1],
      originalPath: ["body", 1],
      anchoredAfterOp: 0,
      text: "Check the price.",
      quote: "The price is 100 CZK.",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(session.comments).toEqual([comment]);
  });

  it("quotes an article by its number and heading, and takes the author from the session", () => {
    const session = startSession({ author: "jana" });

    const comment = session.addComment({ path: ["body", 2], text: "Add a definition of Price." });

    expect(comment.quote).toBe("1 Definitions");
    expect(comment.author).toBe("jana");
  });

  it("records how far the op log had run when the comment was anchored", () => {
    const session = startSession();
    session.apply(setTitle);

    const comment = session.addComment({ path: ["body", 1], text: "Later note." });

    expect(comment.anchoredAfterOp).toBe(1);
  });

  it("refuses an anchor that addresses nothing, and a duplicate id", () => {
    const session = startSession();
    session.addComment({ id: "c9", path: ["body", 1], text: "First." });

    expect(() => session.addComment({ path: ["body", 99], text: "Nowhere." })).toThrow(EditError);
    expect(() => session.addComment({ id: "c9", path: ["body", 1], text: "Again." })).toThrow(EditSessionError);
    expect(session.comments).toHaveLength(1);
  });
});

describe("session comments — rebasing through ops", () => {
  it("shifts the anchor when a node is inserted before it", () => {
    const session = startSession();
    session.addComment({ path: ["body", 1], text: "Check the price." });

    session.apply(insertFirst);

    expect(session.comments[0]!.path).toEqual(["body", 2]);
    expect(session.comments[0]!.originalPath).toEqual(["body", 1]);
  });

  it("leaves the anchor alone for an edit inside another node", () => {
    const session = startSession();
    session.addComment({ path: ["body", 1], text: "Check the price." });

    session.apply(setTitle);

    expect(session.comments[0]!.path).toEqual(["body", 1]);
  });

  it("orphans the comment when its anchor is removed, and restores it on undo", () => {
    const session = startSession();
    session.addComment({ path: ["body", 1], text: "Check the price." });

    session.apply(removePrice);
    expect(session.comments[0]!.path).toBeNull();

    session.undo();
    expect(session.comments[0]!.path).toEqual(["body", 1]);

    session.redo();
    expect(session.comments[0]!.path).toBeNull();
  });

  it("re-derives the anchor through a chain of structural ops", () => {
    const session = startSession();
    session.addComment({ path: ["body", 3], text: "One more bullet?" });

    session.apply(insertFirst);
    session.apply(removePrice);

    expect(session.comments[0]!.path).toEqual(["body", 3]);
    session.undo();
    expect(session.comments[0]!.path).toEqual(["body", 4]);
  });

  it("re-anchors a comment left beyond the cursor when the redo tail is truncated", () => {
    const session = startSession();
    session.apply(setTitle);
    session.addComment({ path: ["body", 1], text: "Check the price." });
    expect(session.comments[0]!.anchoredAfterOp).toBe(1);

    session.undo();
    // Below its anchor point the comment can only be shown where it was authored.
    expect(session.comments[0]!.path).toEqual(["body", 1]);

    session.apply(insertFirst);

    expect(session.comments[0]!.anchoredAfterOp).toBe(0);
    expect(session.comments[0]!.path).toEqual(["body", 2]);
  });

  it("hands out the same comments array until something changes it", () => {
    const session = startSession();
    session.addComment({ path: ["body", 1], text: "Check the price." });
    const first = session.comments;

    expect(session.comments).toBe(first);

    session.apply(insertFirst);
    expect(session.comments).not.toBe(first);
    expect(session.comments[0]!.path).toEqual(["body", 2]);
  });
});

describe("session comments — lifecycle", () => {
  it("edits, resolves and removes without touching the undo stack", () => {
    const session = startSession();
    session.apply(setTitle);
    session.apply(rewordPrice);
    session.undo();
    const before = { cursor: session.cursor, ops: session.ops.length, tree: session.tree };
    const comment = session.addComment({ path: ["body", 1], text: "Check the price." });
    session.addComment({ id: "doomed", path: ["body", 1], text: "Delete me." });

    const edited = session.editComment(comment.id, "Check the price against the term sheet.");
    const resolved = session.resolveComment(comment.id);
    expect(session.removeComment("doomed")).toBe(true);
    expect(session.removeComment("doomed")).toBe(false);

    expect(edited.text).toBe("Check the price against the term sheet.");
    expect(resolved.resolved).toBe(true);
    expect(session.resolveComment(comment.id, false).resolved).toBe(false);
    expect(session.comments).toHaveLength(1);
    expect(session.cursor).toBe(before.cursor);
    expect(session.ops).toHaveLength(before.ops);
    expect(session.tree).toBe(before.tree);
    expect(session.canRedo).toBe(true);
  });

  it("notifies subscribers when a comment changes", () => {
    const session = startSession();
    const listener = vi.fn();
    session.subscribe(listener);

    const comment = session.addComment({ path: ["body", 1], text: "Check the price." });
    session.editComment(comment.id, "Reworded.");
    session.resolveComment(comment.id);
    session.removeComment(comment.id);

    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("refuses to edit or resolve an unknown comment", () => {
    const session = startSession();

    expect(() => session.editComment("nope", "text")).toThrow(EditSessionError);
    expect(() => session.resolveComment("nope")).toThrow(EditSessionError);
  });
});

describe("session comments — Edit set round trip", () => {
  it("exports comments at their current anchors and resumes into an identical session", () => {
    const session = startSession({ author: "jana" });
    session.apply(setTitle);
    session.addComment({ path: ["body", 1], text: "Check the price." });
    session.addComment({ path: ["body", 3], text: "Resolved note." });
    session.resolveComment("c2");
    session.apply(insertFirst);

    const editSet = session.toEditSet();
    expect(editSet.comments).toEqual(session.comments);
    expect(editSet.comments?.[0]!.path).toEqual(["body", 2]);

    const wire = JSON.parse(JSON.stringify(editSet)) as unknown;
    assertValidEditSet(wire);

    const resumed = createEditSession({
      base: { id: BASE_ID, tree: structuredClone(baseTree) },
      editSet: wire,
      now: fixedNow,
    });

    expect(resumed.comments).toEqual(session.comments);
    expect(resumed.toEditSet()).toEqual(editSet);
    // A resumed session re-derives anchors from the log, so undo still un-orphans correctly.
    resumed.undo();
    expect(resumed.comments[0]!.path).toEqual(["body", 1]);
  });

  it("omits comments from the Edit set when there are none", () => {
    const session = startSession();
    session.apply(setTitle);

    expect(session.toEditSet().comments).toBeUndefined();
    expect(session.comments).toEqual([]);
  });

  it("clamps an Edit set whose comment claims more ops than it carries", () => {
    const session = createEditSession({
      base: { id: BASE_ID, tree: structuredClone(baseTree) },
      now: fixedNow,
      editSet: {
        schemaVersion: 1,
        baseSnapshotId: BASE_ID,
        ops: [],
        comments: [
          { id: "c1", path: ["body", 1], originalPath: ["body", 1], anchoredAfterOp: 7, text: "From elsewhere." },
        ],
      },
    });

    expect(session.comments[0]!.anchoredAfterOp).toBe(0);
    expect(session.comments[0]!.path).toEqual(["body", 1]);
  });
});
