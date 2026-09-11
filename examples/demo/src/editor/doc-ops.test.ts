import { describe, expect, it } from "vitest";
import { Fragment, Slice } from "prosemirror-model";
import type { Node as PmNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { createEditSession, diffTree, normalizeTree } from "@petrpus/legal-docs/edit";
import type { DocumentTree, EditOp, EditSession } from "@petrpus/legal-docs/edit";
import { documentSchema, pmDocToTree, treeToPmDoc } from "./pm-schema";
import { opsBetween, syncSessionToDoc, treePathAt } from "./doc-ops";

/**
 * The WYSIWYG half of the editing layer (#159), proved against a **headless editor state**: a real
 * `EditorState` over the E8 ProseMirror schema, transactions that stand for what a human does in the
 * editor (typing, pasting, splitting, joining, reordering), and the assertion that the resulting ops
 * are the ones an Edit set should carry.
 *
 * The invariant every case shares lives in `sync()`: after the emitted ops go through the session, the
 * session's tree **is** the editor's document. That is what makes the editor a view of the session
 * rather than a second source of truth.
 */

const baseTree: DocumentTree = {
  body: [
    { kind: "title", text: "Service Agreement" },
    { kind: "partyHeader", party: { name: "Acme s.r.o.", idNumber: "123" }, roleLabel: "Provider" },
    {
      kind: "richText",
      value: {
        type: "doc",
        blocks: [
          {
            type: "paragraph",
            runs: [{ text: "The " }, { text: "Provider", marks: ["bold"] }, { text: " shall deliver." }],
          },
        ],
      },
    },
    {
      kind: "article",
      no: "1",
      level: 1,
      heading: "Scope",
      body: [
        { kind: "paragraph", text: "First sentence." },
        { kind: "paragraph", text: "Second sentence." },
        {
          kind: "numberedList",
          items: [[{ kind: "paragraph", text: "Alpha" }], [{ kind: "paragraph", text: "Beta" }]],
        },
      ],
    },
  ],
};

function sessionFor(tree: DocumentTree = baseTree): EditSession {
  return createEditSession({ base: tree, baseSnapshotId: "base-1", author: "Test" });
}

function stateFor(session: EditSession): EditorState {
  return EditorState.create({ doc: treeToPmDoc(session.tree) });
}

/** Every node of a type, in document order, with its position — the test's way to aim a transaction. */
function nodesOf(doc: PmNode, type: string): { node: PmNode; pos: number }[] {
  const found: { node: PmNode; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === type) found.push({ node, pos });
  });
  return found;
}

function nodeAt(doc: PmNode, type: string, nth = 0): { node: PmNode; pos: number } {
  const hit = nodesOf(doc, type)[nth];
  if (hit === undefined) throw new Error(`no ${type}[${nth}] in the document`);
  return hit;
}

/** The end of a text block's content — where typing at the end of a paragraph lands. */
function endOf(hit: { node: PmNode; pos: number }): number {
  return hit.pos + hit.node.nodeSize - 1;
}

/**
 * Push the editor's document into the session and assert the two ended up identical. Returns the ops,
 * which each test then pins — the ops ARE the Edit set the export replays.
 */
function sync(session: EditSession, state: EditorState): EditOp[] {
  const { ops, error } = syncSessionToDoc(session, state.doc);
  expect(error).toBeUndefined();
  expect(normalizeTree(session.tree)).toEqual(pmDocToTree(state.doc));
  return ops;
}

describe("opsBetween — typing", () => {
  it("emits one setText for a paragraph", () => {
    const session = sessionFor();
    const state = stateFor(session);
    const p = nodeAt(state.doc, "paragraph", 0);
    const next = state.apply(state.tr.insertText(" Amended.", endOf(p)));

    expect(sync(session, next)).toEqual([
      { op: "setText", path: ["body", 3, "body", 0, "text"], value: "First sentence. Amended." },
    ]);
  });

  it("emits one setRichText for a rich-text clause, keeping the runs' marks", () => {
    const session = sessionFor();
    const state = stateFor(session);
    const para = nodeAt(state.doc, "richPara", 0);
    const next = state.apply(state.tr.insertText("Note: ", para.pos + 1));

    expect(sync(session, next)).toEqual([
      {
        op: "setRichText",
        path: ["body", 2, "value"],
        value: {
          type: "doc",
          blocks: [
            {
              type: "paragraph",
              runs: [{ text: "Note: The " }, { text: "Provider", marks: ["bold"] }, { text: " shall deliver." }],
            },
          ],
        },
      },
    ]);
  });

  it("emits setText for an article heading and never touches its number or level", () => {
    const session = sessionFor();
    const state = stateFor(session);
    const heading = nodeAt(state.doc, "articleHeading", 0);
    const next = state.apply(state.tr.insertText(" of Work", endOf(heading)));

    expect(sync(session, next)).toEqual([
      { op: "setText", path: ["body", 3, "heading"], value: "Scope of Work" },
    ]);
    expect(session.getNode(["body", 3])).toMatchObject({ no: "1", level: 1 });
  });

  it("emits nothing when the document did not change", () => {
    const session = sessionFor();
    expect(sync(session, stateFor(session))).toEqual([]);
  });
});

describe("pasting marked content", () => {
  const bold = documentSchema.marks.bold!.create();
  const italic = documentSchema.marks.italic!.create();

  function paste(state: EditorState, pos: number, content: PmNode[]): EditorState {
    const tr = state.tr.setSelection(TextSelection.create(state.doc, pos));
    return state.apply(tr.replaceSelection(new Slice(Fragment.from(content), 0, 0)));
  }

  it("strips every mark in a title or paragraph", () => {
    expect(documentSchema.nodes.title!.allowsMarkType(documentSchema.marks.bold!)).toBe(false);
    expect(documentSchema.nodes.paragraph!.allowsMarkType(documentSchema.marks.italic!)).toBe(false);

    const session = sessionFor();
    const state = stateFor(session);
    const title = nodeAt(state.doc, "title", 0);
    const next = paste(state, endOf(title), [documentSchema.text(" (draft)", [bold, italic])]);

    expect(sync(session, next)).toEqual([
      { op: "setText", path: ["body", 0, "text"], value: "Service Agreement (draft)" },
    ]);
    expect(session.getNode(["body", 0])).toEqual({ kind: "title", text: "Service Agreement (draft)" });
  });

  it("keeps bold and italic in a rich-text clause, and nothing else exists to keep", () => {
    expect(Object.keys(documentSchema.marks)).toEqual(["bold", "italic"]);

    const session = sessionFor();
    const state = stateFor(session);
    const para = nodeAt(state.doc, "richPara", 0);
    const next = paste(state, endOf(para), [documentSchema.text(" Signed.", [italic])]);

    const ops = sync(session, next);
    expect(ops).toHaveLength(1);
    expect(session.getNode(["body", 2])).toMatchObject({
      value: {
        blocks: [
          {
            runs: [
              { text: "The " },
              { text: "Provider", marks: ["bold"] },
              { text: " shall deliver." },
              { text: " Signed.", marks: ["italic"] },
            ],
          },
        ],
      },
    });
  });
});

describe("structural steps", () => {
  it("maps a paragraph split to setText + insertNode", () => {
    const session = sessionFor();
    const state = stateFor(session);
    const p = nodeAt(state.doc, "paragraph", 0);
    const next = state.apply(state.tr.split(p.pos + 1 + "First".length));

    expect(sync(session, next)).toEqual([
      { op: "setText", path: ["body", 3, "body", 0, "text"], value: "First" },
      { op: "insertNode", path: ["body", 3, "body", 1], node: { kind: "paragraph", text: " sentence." } },
    ]);
  });

  it("maps a paragraph join to setText + removeNode", () => {
    const session = sessionFor();
    const state = stateFor(session);
    const second = nodeAt(state.doc, "paragraph", 1);
    const next = state.apply(state.tr.join(second.pos));

    expect(sync(session, next)).toEqual([
      { op: "setText", path: ["body", 3, "body", 0, "text"], value: "First sentence.Second sentence." },
      { op: "removeNode", path: ["body", 3, "body", 1] },
    ]);
  });

  it("maps reordered list items to removeListItem + insertListItem, and the redline shows both", () => {
    const session = sessionFor();
    const state = stateFor(session);
    const list = nodeAt(state.doc, "list", 0);
    const reordered = list.node.type.create(list.node.attrs, [list.node.child(1), list.node.child(0)]);
    const next = state.apply(state.tr.replaceWith(list.pos, list.pos + list.node.nodeSize, reordered));

    const items = ["body", 3, "body", 2, "items"];
    expect(sync(session, next)).toEqual([
      { op: "removeListItem", path: [...items, 0] },
      { op: "insertListItem", path: [...items, 1], item: [{ kind: "paragraph", text: "Alpha" }] },
    ]);

    // The redline reads the reorder as the removal and the insertion it is, at the item's own paths.
    expect(diffTree(session.base, session.tree)).toEqual([
      { change: "removedItem", path: [...items, 0], item: [{ kind: "paragraph", text: "Alpha" }] },
      { change: "insertedItem", path: [...items, 1], item: [{ kind: "paragraph", text: "Alpha" }] },
    ]);
    const html = session.redlineHtml();
    expect(html).toContain(`class="redline-item redline-item--del" data-base-path="/body/3/body/2/items/0"`);
    expect(html).toContain(`class="redline-item redline-item--ins" data-path="/body/3/body/2/items/1"`);
  });

  it("maps a deleted block to removeNode and a typed-in block to insertNode", () => {
    const session = sessionFor();
    const state = stateFor(session);
    const second = nodeAt(state.doc, "paragraph", 1);
    const removed = state.apply(state.tr.delete(second.pos, second.pos + second.node.nodeSize));

    expect(sync(session, removed)).toEqual([{ op: "removeNode", path: ["body", 3, "body", 1] }]);

    const at = nodeAt(removed.doc, "paragraph", 0);
    const added = removed.apply(
      removed.tr.insert(at.pos + at.node.nodeSize, documentSchema.nodes.paragraph!.createChecked(null, documentSchema.text("Inserted."))),
    );
    expect(sync(session, added)).toEqual([
      { op: "insertNode", path: ["body", 3, "body", 1], node: { kind: "paragraph", text: "Inserted." } },
    ]);
  });

  it("maps an atom's node-view edit to one replaceNode", () => {
    const session = sessionFor();
    const state = stateFor(session);
    const party = nodeAt(state.doc, "partyHeader", 0);
    const next = state.apply(
      state.tr.setNodeMarkup(party.pos, undefined, {
        ...party.node.attrs,
        party: { name: "Acme a.s.", idNumber: "123" },
      }),
    );

    expect(sync(session, next)).toEqual([
      {
        op: "replaceNode",
        path: ["body", 1],
        node: { kind: "partyHeader", party: { name: "Acme a.s.", idNumber: "123" }, roleLabel: "Provider" },
      },
    ]);
  });
});

describe("undo/redo stay the session's", () => {
  it("re-projects the editor from the session after an undo", () => {
    const session = sessionFor();
    const state = stateFor(session);
    const p = nodeAt(state.doc, "paragraph", 0);
    const typed = state.apply(state.tr.insertText(" Amended.", endOf(p)));
    sync(session, typed);

    expect(session.undo()).toBe(true);
    // The editor is now stale: its document still holds the edit the session stepped back over.
    expect(treeToPmDoc(session.tree).eq(typed.doc)).toBe(false);
    // Re-projecting is what the shell does — and after it, there is nothing left to sync.
    const projected = EditorState.create({ doc: treeToPmDoc(session.tree) });
    expect(sync(session, projected)).toEqual([]);

    expect(session.redo()).toBe(true);
    expect(treeToPmDoc(session.tree).eq(typed.doc)).toBe(true);
  });

  it("truncates the redo tail when the editor edits after an undo", () => {
    const session = sessionFor();
    let state = stateFor(session);
    const p = nodeAt(state.doc, "paragraph", 0);
    state = state.apply(state.tr.insertText(" One.", endOf(p)));
    sync(session, state);
    session.undo();

    const reprojected = EditorState.create({ doc: treeToPmDoc(session.tree) });
    const heading = nodeAt(reprojected.doc, "articleHeading", 0);
    sync(session, reprojected.apply(reprojected.tr.insertText("!", endOf(heading))));

    expect(session.canRedo).toBe(false);
    expect(session.cursor).toBe(1);
  });
});

describe("treePathAt — the caret's block", () => {
  const session = sessionFor();
  const doc = treeToPmDoc(session.tree);
  const at = (pos: number) => treePathAt(doc.resolve(pos));

  it("addresses the block the caret sits in", () => {
    expect(at(nodeAt(doc, "title", 0).pos + 1)).toEqual(["body", 0]);
    expect(at(nodeAt(doc, "richPara", 0).pos + 1)).toEqual(["body", 2]);
    expect(at(nodeAt(doc, "paragraph", 1).pos + 1)).toEqual(["body", 3, "body", 1]);
    expect(at(nodeAt(doc, "paragraph", 2).pos + 1)).toEqual(["body", 3, "body", 2, "items", 0, 0]);
  });

  it("addresses the article itself from its heading, which is a field and not a block", () => {
    expect(at(nodeAt(doc, "articleHeading", 0).pos + 1)).toEqual(["body", 3]);
  });

  it("addresses an atom selected as a whole node", () => {
    expect(at(nodeAt(doc, "partyHeader", 0).pos)).toEqual(["body", 1]);
  });
});

describe("syncSessionToDoc", () => {
  it("reports a rejected op instead of throwing, leaving the session at the last good state", () => {
    const session = sessionFor();
    const doc = treeToPmDoc(session.tree);
    // A tree the editor cannot produce: `custom` is an atom the node view never edits, so an op model
    // that cannot express its insertion is the honest answer — the shell re-projects and moves on.
    const withCustom: DocumentTree = {
      body: [...baseTree.body, { kind: "custom", component: "qr-code", props: { value: "x" } }],
    };
    const result = syncSessionToDoc(session, treeToPmDoc(withCustom));
    expect(result.ops).toEqual([]);
    expect(result.error?.message).toMatch(/custom/i);
    expect(session.cursor).toBe(0);
    expect(treeToPmDoc(session.tree).eq(doc)).toBe(true);
  });
});
