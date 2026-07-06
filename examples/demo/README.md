# legal-docs demo

A minimal **Vite + React** app to try `@petrpus/legal-docs` hands-on: pick a template (and variant),
switch locale and format, restyle live via the **whole Theme** token surface, edit a typed payload
(and watch validation fail), and view a **Clause diff** rendered to HTML.

## How it works

PDF, DOCX and the file Catalog are **Node-side**, so rendering runs in the Vite **dev server** (a tiny
API in `vite.config.ts`); the browser only sends `{ template, variant, locale, theme, data, format }`
and displays the returned **HTML** (or downloads the **PDF/DOCX** binary). This is the seam a real app
puts behind its own server — the React client never imports the library. The server also holds the
code-side pieces some templates need (payload **schemas**, **derivations**, and the signature-grid
**Custom block**), keyed by template.

```
React UI ──POST /api/render {template, variant, locale, theme, data, format}──▶ dev-server (Node) ─▶ renderDocument
        ◀──────────────────── { html }  or  { base64 } (pdf/docx) ──────────────────────────────┘
```

## Run

From the repo root, build the library once (the demo imports its `dist`):

```sh
npm install        # repo root
npm run build      # repo root → dist/
```

Then, in this folder:

```sh
cd examples/demo
npm install
npm run dev        # → http://localhost:5173
```

(Re-run `npm run build` at the root after changing the library source.)

## What you can try

- **Templates** — a broader catalog: `hello` / `agreement` / `contract` (static prose), `greeting` and
  `parties` (typed payloads with a key/value table), `signoff` (a `signatures` block), `terms`
  (`for`/`if` control flow + code-side **derivations** that pick a Clause version by party count),
  `localized` (locale-aware), `signature-grid` (a **Custom block**), and `styled` (per-block
  **alignment + indentation**, ADR-0008).
- **Variants** — `pledge-agreement` is a Variant **family**: pick `two-party` / `three-party` and the
  `security` slot resolves to a different Clause version.
- **Theme** — the editor walks the **whole Theme** object, so every token is editable (sizes, spacing,
  alignment, indents, colours, table & signature styling); enum tokens (alignment, page size) render as
  a dropdown. Re-render and see all formats restyle from the one Theme (reference in
  [`../../docs/THEMING.md`](../../docs/THEMING.md)).
- **Block styling** — the `styled` template shows per-block **alignment** (centre / right / justify) and
  **indentation** (block left + first-line); tweak `theme.align`/`theme.indent` to change the defaults.
- **Locale** — render `localized` in `en` vs `cs` (the per-render `locale` override).
- **Fields & validation** — edit any typed payload's JSON; invalid data fails schema validation and the
  error is shown.
- **Custom block** — `signature-grid` shows the escape hatch: a multi-column signature grid the core
  `signatures` node can't express, rendered across html/pdf/docx (source: [`../signature-grid.tsx`](../signature-grid.tsx)).
- **Formats** — `html` previews inline; `pdf` / `docx` download.
- **Clause diff** — diff two versions of the `counterparts` Clause, rendered via `renderClauseDiff`.
- **Editor (Phase 7 / ADR-0009)** — a runtime **Clause editor** over the library's editing API
  (`catalog.editing`): create a draft new version, **submit → publish** through the `draft → in_review
  → published` workflow, see the **old→new review diff** (`previewDiff`) and the **edit audit log**.
  Publishing runs the `validate()` **gate** (a draft that would break a consuming template is blocked
  with findings). Backed by the in-memory `MemoryEditableCatalogStore` (state resets when the dev
  server restarts); the persistent alternative is the `node:sqlite` adapter in
  [`../../adapters/sqlite/`](../../adapters/sqlite/), which passes the same conformance suite.

## A note on safety

The preview uses `dangerouslySetInnerHTML` on the library's HTML output. That is safe **here** because
the renderer escapes all core-emitted text (incl. the payload you type), and the one Custom block in
this demo (`signature-grid`) escapes its own data with the library's `escapeHtml`. A Custom block's
HTML output is inserted **raw** and trusted — if you register one that emits unescaped user input, or
feed user-authored templates, you reintroduce an XSS surface. Sanitize accordingly.

## Notes

- The **Render** and **Clause diff** tabs read the file-based sample catalog (`Catalog.fromDir`).
- The **Editor** tab uses a separate in-memory editable catalog (`MemoryEditableCatalogStore` via
  `Catalog.fromStore`), so its edits are isolated from the sample catalog and reset when the dev server
  restarts. The persistent alternative is the `node:sqlite` adapter in
  [`../../adapters/sqlite/`](../../adapters/sqlite/).
