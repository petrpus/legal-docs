import { describe, expect, it } from "vitest";
import type { DocumentTree } from "../src/core/document-tree";
import { applyEdits } from "../src/core/edit/apply";
import { buildRedline } from "../src/core/edit/redline-model";
import type { EditOp } from "../src/core/edit/edit-set";
import { parseTreePath as p } from "../src/core/edit/tree-path";
import type { CustomBlockRegistry } from "../src/custom-block";
import { createEditSession } from "../src/edit";
import { renderTreeToHtml } from "../src/render-html/render-html";
import { renderRedlineHtml } from "../src/render-html/redline";
import { allKindsTree } from "./fixtures/all-kinds-tree";

/**
 * One Edit set over the all-kinds fixture carrying a change of every kind the redline has to tell a
 * story about: a paragraph reworded, rich text with marks rewritten, an article heading, a key-value
 * cell, a party field, a signature place, an inserted paragraph, a deleted list item, a moved node, an
 * alignment override, a replaced `custom` block and a page-furniture slot.
 */
const ops: EditOp[] = [
  { op: "setText", path: p("/body/1/text"), value: "Entered into on 2 February 2026." },
  {
    op: "setRichText",
    path: p("/body/2/value"),
    value: {
      type: "doc",
      blocks: [{ type: "paragraph", runs: [{ text: "Plain " }, { text: "bold", marks: ["bold"] }, { text: " and rewritten." }] }],
    },
  },
  { op: "setText", path: p("/body/3/party/name"), value: "Acme Bank SE" },
  { op: "setText", path: p("/body/5/heading"), value: "Definitions and interpretation" },
  { op: "setStyle", path: p("/body/5/body/0/align"), value: "center" },
  { op: "setText", path: p("/body/8/rows/1/value"), value: "5.0 %" },
  { op: "setText", path: p("/body/11/places/1/role"), value: "Pledgor" },
  { op: "setFurniture", path: p("/header"), value: { left: "Pledge Agreement", center: "", right: "Internal" } },
  // Structural ops last, so the leaf paths above read against the fixture's own indices.
  { op: "removeListItem", path: p("/body/6/items/1") },
  { op: "insertNode", path: p("/body/7"), node: { kind: "paragraph", text: "A brand new recital." } },
  // Moved inside the article, past the numbered list. A move crosses the alignment, so it is kept away
  // from the reworded blocks: paired positionally against one, it would read as "replaced" instead.
  { op: "moveNode", from: p("/body/5/body/1"), to: p("/body/5/body/2") },
];

/** Both fixture components, so nothing degrades and the `custom` cases render as real markup. */
const customBlocks: CustomBlockRegistry = {
  "qr-code": { html: () => `<span class="qr">QR</span>` },
  "page-break": { html: () => `<hr class="page-break">` },
};
const options = { customBlocks, degradation: "throw" } as const;

function editedTree(): DocumentTree {
  const edited = applyEdits(allKindsTree, ops);
  // A `custom` block is opaque to editing (ADR-0005), so no op can touch it — its props are changed
  // directly here. The redline must still report it, as a deletion plus an insertion.
  const custom = edited.body[10];
  if (custom?.kind !== "custom") throw new Error("fixture drift: /body/10 is no longer a custom block");
  custom.props = { value: "https://example.test/changed", size: 128 };
  return edited;
}

function redlineOf(base: DocumentTree, edited: DocumentTree): string {
  return renderRedlineHtml(buildRedline(base, edited), options);
}

/** The blocks between the scoped `<style>` and the closing root tag — what the two Renderers share. */
function bodyOf(html: string): string {
  return html.slice(html.indexOf("</style>") + "</style>".length, -"</div>".length);
}

describe("renderRedlineHtml", () => {
  it("renders one change of every kind inline (golden)", () => {
    expect(redlineOf(allKindsTree, editedTree())).toMatchSnapshot();
  });

  it("marks every kind of change", () => {
    const html = redlineOf(allKindsTree, editedTree());

    // Word-level text changes: only the words that moved are marked, not the whole leaf.
    expect(html).toContain("Entered into on <del>1</del><ins>2</ins> <del>January</del><ins>February</ins> 2026.");
    expect(html).toContain("Definitions<ins> and interpretation</ins>");
    expect(html).toContain("<del>4.5</del><ins>5.0</ins> %");
    expect(html).toContain("Acme Bank <del>a.s.</del><ins>SE</ins>");
    expect(html).toContain("<ins>Pledgor</ins>");
    // Rich text keeps its marks on both sides of the diff.
    expect(html).toContain("<del><em>italic</em></del>");
    expect(html).toContain("<ins>rewritten.</ins>");
    // Block-level verdicts: an insertion, a deletion (the moved title and the replaced custom block),
    // a dropped list item and a presentation-only change.
    expect(html).toContain("redline-block--ins");
    expect(html).toContain("redline-block--del");
    expect(html).toContain("redline-item--del");
    expect(html).toContain("redline-block--attr");
    expect(html).toContain("align: justify → center");
    // Page furniture has no place in an HTML document, so it is reported as its own section.
    expect(html).toContain("redline-furniture");
    expect(html).toContain("/header/right");
  });

  it("renders the plain document when nothing changed", () => {
    const html = redlineOf(allKindsTree, structuredClone(allKindsTree));

    // Only the scoped `<style>` and the root's own class differ from the plain Renderer's output.
    expect(bodyOf(html)).toBe(bodyOf(renderTreeToHtml(allKindsTree, { ...options, emitPaths: true })));
    expect(bodyOf(html)).not.toContain("<ins>");
    expect(bodyOf(html)).not.toContain("<del>");
    expect(bodyOf(html)).not.toContain("redline-");
  });

  it("addresses blocks by data-path, and a deleted block only by its base-tree path", () => {
    const html = redlineOf(allKindsTree, editedTree());

    // The inserted paragraph sits at /body/7 in the edited tree.
    expect(html).toContain('data-path="/body/7"');
    // The moved article was deleted from /body/5/body/1 in the BASE tree — a path that addresses a
    // different node in the document being edited, so it is never offered as a selectable `data-path`.
    expect(html).toContain('data-base-path="/body/5/body/1"');
    // A deleted block's children keep no addresses at all.
    expect(html).not.toContain('data-path="/body/5/body/1/body/0"');
  });

  it("escapes text on both sides of a change", () => {
    const base: DocumentTree = { body: [{ kind: "paragraph", text: "<b>old</b>" }] };
    const edited = applyEdits(base, [{ op: "setText", path: p("/body/0/text"), value: "<i>new</i> & bold" }]);

    const html = renderRedlineHtml(buildRedline(base, edited));

    expect(html).toContain("<del>&lt;b&gt;old&lt;/b&gt;</del>");
    expect(html).toContain("&lt;i&gt;new&lt;/i&gt; &amp; bold");
    expect(html).not.toContain("<b>old</b>");
  });

  it("reserves side-by-side without implementing it", () => {
    const redline = buildRedline(allKindsTree, structuredClone(allKindsTree));

    expect(renderRedlineHtml(redline, options)).toContain("legal-redline--inline");
    expect(() => renderRedlineHtml(redline, { ...options, mode: "sideBySide" as "inline" })).toThrow(/side-by-side/i);
  });
});

describe("the session exposes its own redline", () => {
  function session() {
    const s = createEditSession({ base: structuredClone(allKindsTree), customBlocks });
    for (const op of ops) {
      const result = s.apply(op);
      if (!result.ok) throw result.error;
    }
    return s;
  }

  it("diffs the base against the tree at the cursor", () => {
    const s = session();

    expect(s.redline().stats.changed).toBeGreaterThan(0);
    expect(s.redlineHtml()).toBe(renderRedlineHtml(s.redline(), { customBlocks }));
  });

  it("follows undo back to an unchanged document", () => {
    const s = session();
    while (s.undo()) {
      // rewind to the base
    }

    expect(s.redline().stats.changed).toBe(0);
    expect(s.redlineHtml()).not.toContain("<ins>");
  });
});
