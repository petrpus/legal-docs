import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import {
  buildEditedSnapshot,
  buildSnapshot,
  renderEdited,
  renderFromSnapshot,
  verifyEditedSnapshot,
} from "@petrpus/legal-docs";
import { createEditSession } from "@petrpus/legal-docs/edit";
import type { DocumentTree } from "@petrpus/legal-docs/edit";
import { treeToPmDoc } from "./pm-schema";
import { syncSessionToDoc } from "./doc-ops";

/**
 * The whole WYSIWYG flow end to end (#159): type in the editor → ops → an **Edit set** → an edited
 * Snapshot → the three exporters, and the stored Snapshot re-rendering to the same bytes.
 *
 * Nothing here is editor-specific except where the ops come from — which is the point. The export path
 * is the library's own (`tests/render-edited.test.ts`, `tests/demo-api.test.ts`); what this pins is that
 * ops mapped from a ProseMirror document are ordinary Edit-set ops that survive it.
 */

const tree: DocumentTree = {
  body: [
    { kind: "title", text: "Mutual NDA" },
    {
      kind: "article",
      no: "1",
      level: 1,
      heading: "Confidentiality",
      body: [
        { kind: "paragraph", text: "The parties keep the information secret." },
        { kind: "paragraph", text: "This obligation survives termination." },
      ],
    },
  ],
};

/** The caret position at the end of the first block of a kind — where typing appends to it. */
function endOfFirst(state: EditorState, type: string): number {
  let end: number | undefined;
  state.doc.descendants((node, pos) => {
    if (end === undefined && node.type.name === type) end = pos + node.nodeSize - 1;
  });
  if (end === undefined) throw new Error(`no ${type} in the document`);
  return end;
}

const base = buildSnapshot(
  { template: "nda", version: 1, locale: "en", payload: {}, resolved: {}, pins: [], tree },
  "tree",
);

describe("a WYSIWYG-edited document exports and re-renders", () => {
  it("carries the editor's ops through an edited Snapshot into HTML, PDF and DOCX", async () => {
    const session = createEditSession({ base, author: "Demo Editor" });
    let state = EditorState.create({ doc: treeToPmDoc(session.tree) });

    // Two edits a human would make with the caret: extend the first clause, then retitle the document.
    state = state.apply(state.tr.insertText(" No exceptions.", endOfFirst(state, "paragraph")));
    state = state.apply(state.tr.insertText(" (2026)", endOfFirst(state, "title")));
    expect(syncSessionToDoc(session, state.doc).error).toBeUndefined();

    const edits = session.toEditSet();
    expect(edits.ops).toHaveLength(2);

    const edited = buildEditedSnapshot(base, edits);
    expect(verifyEditedSnapshot(base, edited).ok).toBe(true);
    expect(edited.derivedFrom.baseSnapshotId).toBe(base.id);
    expect(edited.id).not.toBe(base.id);

    // The export IS the edited Snapshot's rendering, and re-rendering the stored Snapshot repeats it.
    const exported = await renderEdited({ snapshot: base, edits, format: "html" });
    const rerendered = await renderFromSnapshot(edited, { format: "html" });
    expect(rerendered.html).toBe(exported.html);
    expect(rerendered.html).toContain("Mutual NDA (2026)");
    expect(rerendered.html).toContain("keep the information secret. No exceptions.");

    const pdf = await renderFromSnapshot(edited, { format: "pdf" });
    expect(pdf.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const docx = await renderFromSnapshot(edited, { format: "docx" });
    expect(docx.buffer.length).toBeGreaterThan(0);

    // The base is untouched: it still renders the document the human started from.
    const original = await renderFromSnapshot(base, { format: "html" });
    expect(original.html).toContain("Mutual NDA<");
    expect(original.html).toContain("keep the information secret.");
  });
});
