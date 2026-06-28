# The DOCX renderer: docx-lib objects, a flat block model, point-based units

Phase 5 adds the third **Renderer** over the `DocumentNode` tree: DOCX (Word). Word's document model
is materially different from PDF's and HTML's — flat block structure, its own units, library-built XML
— so this ADR fixes the renderer's shape, the Custom-block `docx` slot, the Theme→DOCX unit mapping,
and how nested core nodes are approximated. It also records the rejected alternatives, so a future
maintainer can revisit if the flat approach proves too lossy.

## Decision

**Built on the `docx` npm package, output a binary Buffer.** The renderer is a visitor that returns
`docx` library objects (`Paragraph`, `Table`, `TextRun`, …); `Packer.toBuffer(doc)` serializes to a
Buffer (async). Not raw OOXML strings — the library handles XML escaping and structure (the reason to
use it: `TextRun` takes plain text and the library escapes it, so there is no manual `escapeHtml`-style
boundary). `docx` is a runtime dependency. The result is `{ format: "docx", buffer, stream }` — the
same binary shape as PDF (`DocxRenderResult` parallel to `PdfRenderResult`); HTML's `{ html }` is the
outlier.

**A flat `(Paragraph | Table)[]` block model.** Word has no nested block container (no `div`/`View`):
a Section holds a flat list of block elements, with inline content (`TextRun`) inside a `Paragraph`.
So `nodeToDocx(node, …): (Paragraph | Table)[]` — a node yields one or more block elements — and
**nested nodes are flattened with their nesting carried as paragraph properties**:
- `article` → a heading `Paragraph` followed by its body blocks with a **left indent** (twips) by
  depth; nested articles deepen the indent.
- lists → one `Paragraph` per item with a **manual marker prefix** (`"1. "`, `"• "`, `"a. "`) in the
  text — *not* `docx` numbering definitions (which require registering AbstractNumbering/Numbering on
  the Document); this mirrors how the PDF renderer already composes its `"1."` markers.
- inline bold/italic → `TextRun({ bold, italics })`.
`renderTreeToDocx(tree, theme?, customBlocks?, degradation?): Promise<Buffer>` builds one Section from
the flattened blocks. This flattening is a deliberate, documented approximation of Word's model.

**Custom block `docx` slot + live Degradation.** `CustomBlock.docx?: (props, { theme }) => (Paragraph | Table)[]`
returns block-level docx elements, spliced into the flat list (trusted, inserted as-is; the library
escapes). The `CustomBlock` type imports `Paragraph`/`Table` from `docx` (consistent with already
importing `ReactElement` for `pdf` — it is the cross-format contract). Degradation goes live for the
third format: a block with `pdf`/`html` but no `docx`, rendered to DOCX, degrades per the mode
(`placeholder` → a visible `Paragraph` `[unsupported block: X in docx]` + log; `throw` → fail). The
signature-grid example gains a `docx` impl (a `Table` of signature cells).

**Theme tokens are points; DOCX converts them.** Numeric Theme tokens are treated as **points** (the
PDF renderer uses them as pt; the HTML renderer maps them ~1:1 to px — a documented preview
approximation). A `theme-docx` helper converts: font sizes pt → **half-points** (×2), spacing / indent
/ margins pt → **twips** (×20), border widths pt → **eighths of a point** (×8).

**Facade.** `format` widens to `"pdf" | "html" | "docx"`; a fourth overload returns `DocxRenderResult`;
dispatch stays exhaustive (a `never` guard). `renderFromSnapshot` gains `docx` likewise.
`render-samples.mjs` emits a `.docx` next to each `.pdf`/`.html`.

## Consequences

- A third binary result subtype + overload; `RenderDocumentInput.format` and the discriminated result
  union grow by one arm.
- `CustomBlock` now spans three render libraries (react-pdf, string, docx) while living under
  `render-pdf/`; a future move to a neutral module is noted but deferred to limit churn.
- DOCX output is an *approximation* of the PDF/HTML layout (flat structure, manual list markers); some
  fidelity is intentionally traded for a working, editable Word document.

## Alternatives (revisit if the flat model proves too lossy)

- **Nested tables as containers.** Word supports nested tables; an `article` could be a single-cell,
  borderless `Table` wrapping its body, giving real nesting and indentation via the cell. Heavier and
  slower, but structurally faithful — the fallback if flat indentation reads poorly for deep nesting.
- **Real `docx` numbering definitions** for lists (AbstractNumbering/Numbering registered on the
  Document) instead of manual marker prefixes — gives Word-native, renumbering-aware lists at the cost
  of the numbering-registration machinery.
- **Content controls / structured document tags** for a richer, programmatically-addressable document
  — out of scope now, relevant only if downstream Word automation is needed.
- **Raw OOXML** instead of the `docx` library — full control, but manual XML escaping and brittleness;
  rejected.
