# The HTML renderer: direct strings, fragment output, format-discriminated result

Phase 4 adds the second **Renderer** over the `DocumentNode` tree (HTML, for preview / diff / WYSIWYG)
and the human-readable rendering of the structured Clause diff from #23. This ADR fixes the renderer's
shape — its output type, how the facade returns it, styling, the Custom-block `html` slot, and where
the diff renders — because the result shape and the no-`react-dom` choice are public and costly to
change once consumers depend on them.

## Decision

**A second visitor, building strings directly — no `react-dom`.** The HTML renderer is an independent
`nodeToHtml(node, …): string` exhaustive `switch` over `node.kind`, structurally mirroring the PDF
visitor (TS exhaustiveness guards each separately). It does **not** use `react-dom`/`renderToStaticMarkup`:
the output is static HTML, so a heavy React-DOM dependency buys little. The two renderers share the
*contract* (exhaustive dispatch over the same closed node set), not code. **Every piece of text the
core renderer emits is escaped through a single `escapeHtml` helper** — payload can carry untrusted
strings, so escaping is mandatory and centralized.

**Output is a self-contained fragment.** The renderer emits `<div class="legal-doc">…</div>` with a
**scoped `<style>` block** derived from the shared `Theme` (classes like `.legal-doc h1`,
`.legal-doc .article`; numeric tokens → `px`, colors as-is) — **classes, not inline styles**. A
fragment embeds into a consumer's page (preview/diff/WYSIWYG) without the collisions a full
`<html><head>` document would cause, and still renders standalone. The **same `Theme`** object feeds
both renderers; tokens are format-agnostic, each renderer interprets them.

**The facade discriminates the result by `format`.** `renderDocument` switches on `format`:
`"pdf"` → `renderTreeToPdf`, `"html"` → the HTML renderer; the result is
`format: "pdf"` → `{ buffer, stream, snapshot, snapshotId }`, `format: "html"` → `{ html, snapshot, snapshotId }`
(common `snapshot`/`snapshotId`, which stay format-agnostic — the Snapshot freezes the tree, not the
bytes). `renderFromSnapshot` likewise gains a `format` option (default `pdf`) and the same discriminated
result. A plain `switch` — not a renderer registry — handles dispatch; DOCX (Phase 5) is another case.

**Custom block `html` slot + the now-live Degradation contract.** `CustomBlock.html?: (props, { theme }) => string`.
The HTML dispatch mirrors PDF: unregistered `component` → hard error; a registered block **missing
`html`** triggers the **Degradation contract for real** (default `placeholder` → a visible, logged
`<div class="legal-doc__unsupported">[unsupported block: X in html]</div>`; `throw` → fail hard). A
present `html` impl validates props against the block `schema`, then its returned string is inserted
**raw** — the implementation is trusted consumer code owning its markup (the analogue of the `pdf`
impl owning its react-pdf elements); core-data escaping does not apply to it.

**Clause diff HTML is a standalone view.** `renderClauseDiff(diff: ClauseDiff, theme?) → string`
renders the *unchanged* structured diff from #23 into a self-contained fragment
(`<div class="clause-diff">`, per-change classes `diff-added` / `diff-removed` / `diff-replaced`). It
is **not** routed through `nodeToHtml` (changes are plain text, not `DocumentNode`s) nor through
`renderDocument` (a diff is not a document) — keeping the structured diff (data) and its HTML view
(presentation) cleanly separated.

## Consequences

- `renderDocument` / `renderFromSnapshot` return types become discriminated on `format` (overloads or a
  conditional return keyed on the `format` literal) — consumers get a correctly-typed result with no cast.
- The `degradation` seam built in #36 goes live for HTML; a worked example (the signature-grid Custom
  block) gains an `html` impl, and a pdf-only block rendered to HTML degrades.
- `escapeHtml` is the single XSS boundary for core-emitted text; Custom-block HTML output is explicitly
  outside it (trusted).
- Alternatives rejected: `react-dom` `renderToStaticMarkup` (heavy dep purely for static output, less
  markup control — the loss of auto-escape is mitigated by the centralized helper); a full HTML
  document (collides when embedded); inline styles (verbose, not overridable); a `Buffer | string`
  union or a `Buffer`-wrapped HTML (a confusing "buffer" for text); a renderer registry (premature for
  two/three formats).
