import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFParse } from "pdf-parse";
import JSZip from "jszip";
import { Catalog } from "../src/catalog/catalog";
import type { DocumentTree } from "../src/core/document-tree";
import { EDIT_SET_SCHEMA_VERSION, type EditOp, type EditSet } from "../src/core/edit";
import { createEditSession } from "../src/edit";
import { renderDocument } from "../src/facade/render-document";
import { renderEdited } from "../src/facade/render-edited";
import { renderTreeToHtml } from "../src/render-html/render-html";
import { renderReviewHtml } from "../src/render-html/review";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "fixtures", "snapshot-v1");

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

const rewordPrice: EditOp = { op: "setText", path: ["body", 1, "text"], value: "The price is 120 CZK." };
const removeBullets: EditOp = { op: "removeNode", path: ["body", 3] };

/** A session with one comment of each review state: unresolved, resolved, stale and orphaned. */
function reviewSession() {
  const session = createEditSession({
    base: { id: BASE_ID, tree: structuredClone(baseTree) },
    author: "jana",
    now: fixedNow,
  });
  session.addComment({ path: ["body", 2], text: "Add a definition of Price." });
  session.addComment({ path: ["body", 0], text: "Title agreed with counsel.", author: "petr" });
  session.resolveComment("c2");
  session.addComment({ path: ["body", 1], text: "Check the price." });
  session.addComment({ path: ["body", 3], text: "One more bullet?" });
  // Reword the quoted paragraph (c3 goes stale) and drop the bullet list (c4 orphans).
  session.apply(rewordPrice);
  session.apply(removeBullets);
  return session;
}

describe("renderReviewHtml", () => {
  it("renders the document with margin notes for every comment state (golden)", () => {
    const session = reviewSession();

    const html = renderReviewHtml(session.tree, session.comments);

    expect(html).toMatchSnapshot();
  });

  it("carries the plain document render inside, byte for byte", () => {
    const session = reviewSession();

    const html = renderReviewHtml(session.tree, session.comments);

    expect(html).toContain(renderTreeToHtml(session.tree, { emitPaths: true }));
  });

  it("flags stale and orphaned comments, and dims resolved ones", () => {
    const session = reviewSession();

    const html = renderReviewHtml(session.tree, session.comments);

    expect(html).toContain('data-comment="c1"');
    expect(html).toContain("review-note--resolved");
    expect(html).toContain("review-note--stale");
    expect(html).toContain("review-note--orphaned");
    // An orphaned note can no longer point at a block.
    expect(html).not.toContain('data-comment="c4" data-path');
  });

  it("can hide resolved comments, and says so when there is nothing to show", () => {
    const session = reviewSession();

    const withoutResolved = renderReviewHtml(session.tree, session.comments, { includeResolved: false });
    expect(withoutResolved).not.toContain("Title agreed with counsel.");
    expect(withoutResolved).toContain("Add a definition of Price.");

    expect(renderReviewHtml(session.tree, [])).toContain("legal-review__empty");
  });

  it("escapes comment text, quotes and authors", () => {
    const session = createEditSession({ base: { id: BASE_ID, tree: structuredClone(baseTree) }, now: fixedNow });
    session.addComment({ path: ["body", 1], text: "<script>alert(1)</script>", author: "a&b" });

    const html = renderReviewHtml(session.tree, session.comments);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("a&amp;b");
  });

  it("is available as a session method", () => {
    const session = reviewSession();

    expect(session.reviewHtml()).toBe(renderReviewHtml(session.tree, session.comments));
  });
});

describe("comments never reach an exported document", () => {
  const SECRET = "Check the price.";

  it("is absent from the plain HTML render", () => {
    const session = reviewSession();

    expect(renderTreeToHtml(session.tree, { emitPaths: true })).not.toContain(SECRET);
    expect(session.preview()).not.toContain(SECRET);
  });

  it("is absent from the HTML, PDF and DOCX of the edited Snapshot", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const generated = await renderDocument({ catalog, template: "doc", data: {}, format: "html" });
    const edits: EditSet = {
      schemaVersion: EDIT_SET_SCHEMA_VERSION,
      baseSnapshotId: generated.snapshot.id,
      ops: [{ op: "setText", path: ["body", 0, "text"], value: "AMENDED MEMORANDUM" }],
      comments: [
        {
          id: "c1",
          path: ["body", 0],
          originalPath: ["body", 0],
          anchoredAfterOp: 0,
          text: SECRET,
          quote: "NOTE DOCUMENT",
          author: "jana",
        },
      ],
      at: "2026-09-11T10:00:00.000Z",
    };

    const html = await renderEdited({ snapshot: generated.snapshot, edits, format: "html" });
    const pdf = await renderEdited({ snapshot: generated.snapshot, edits, format: "pdf" });
    const docx = await renderEdited({ snapshot: generated.snapshot, edits, format: "docx" });

    expect(html.html).toContain("AMENDED MEMORANDUM");
    expect(html.html).not.toContain(SECRET);
    const parser = new PDFParse({ data: pdf.buffer });
    try {
      expect((await parser.getText()).text).not.toContain(SECRET);
    } finally {
      await parser.destroy();
    }
    const zip = await JSZip.loadAsync(docx.buffer);
    expect(await zip.file("word/document.xml")!.async("string")).not.toContain(SECRET);
    // `docx` always emits a comments part; ours stays empty until the DOCX redline (#160) fills it.
    expect(await zip.file("word/comments.xml")?.async("string")).not.toContain(SECRET);
  });
});
