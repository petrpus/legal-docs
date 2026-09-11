# legal-docs demo

A minimal **Vite + React** app to try `@petrpus/legal-docs` hands-on: pick a template (and variant),
switch locale and format, restyle live via the **whole Theme** token surface, edit a typed payload
(and watch validation fail), view a **Clause diff** rendered to HTML, and **edit a generated document
before exporting it**.

## How it works

PDF, DOCX and the file Catalog are **Node-side**, so rendering runs on the server — in dev, the Vite
dev server; deployed, the standalone `server.mjs` (see **Deploy** below). Both mount the same
framework-agnostic `/api/*` handler (`server/api.mjs`), so there is exactly one implementation of the
render/diff/schema/editor logic. For everything but the Edit tab the browser only sends
`{ template, variant, locale, theme, data, format }` and displays the returned **HTML** (or downloads
the **PDF/DOCX** binary). The handler also holds the code-side pieces some templates need (payload
**schemas**, **derivations**, and the signature-grid **Custom block**), keyed by template.

```
React UI ──POST /api/render {template, variant, locale, theme, data, format}──▶ server (Node) ─▶ renderDocument
        ◀──────────────────── { html }  or  { base64 } (pdf/docx) ──────────────────────────────┘
```

The **Edit before export** tab is the one place the client imports the library, through the
browser-safe [`@petrpus/legal-docs/edit`](../../docs/adr/0014-post-generation-editing-layer.md) subpath
(resolved from `../../dist/edit.js` by a Vite alias — the same consume-from-`dist` rule as the server
half). See **Edit before export** below.

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
- **Edit before export (ADR-0014)** — edit a *generated* document (not the catalog) and export the
  result as an auditable edited Snapshot. See [**Edit before export**](#edit-before-export) below.
- **Clause editor (Phase 7 / ADR-0009)** — a runtime **Clause editor** over the library's editing API
  (`catalog.editing`): create a draft new version, **submit → publish** through the `draft → in_review
  → published` workflow, see the **old→new review diff** (`previewDiff`) and the **edit audit log**.
  Publishing runs the `validate()` **gate** (a draft that would break a consuming template is blocked
  with findings). Backed by the in-memory `MemoryEditableCatalogStore` (state resets when the dev
  server restarts); the persistent alternative is the `node:sqlite` adapter in
  [`../../adapters/sqlite/`](../../adapters/sqlite/), which passes the same conformance suite.

## Edit before export

The **Edit before export** tab (PRD #147 / [ADR-0014](../../docs/adr/0014-post-generation-editing-layer.md))
is the post-generation editing flow: generate a document, change it as a human would, and export — with
every change frozen as an auditable **Edit set** and an **edited Snapshot**.

```
POST /api/edit/start    {template, variant, data}     ─▶ renderDocument (snapshotMode: "full")
                        ◀── { baseId, tree, html }        base Snapshot stored in memory

   browser: createEditSession({ base: { id: baseId, tree } })  ← the only client-side library import
            apply ops · undo/redo · comments · preview / redline / review

POST /api/edit/export   {baseId, edits, format}       ─▶ renderEdited → edited Snapshot stored
                        ◀── { baseId, editedId, html | base64 }

POST /api/edit/rerender {id, format}                  ─▶ renderFromSnapshot (base *or* edited)
                        ◀── { id, html | base64 }
```

What to try:

1. Pick a template and press **Edit before export**. The server freezes a `full` Snapshot (the tree
   *and* the inputs it came from) and returns the tree.
2. **Write** — the right panel opens on a TipTap **WYSIWYG** over the document: type, split and join
   paragraphs, reorder or delete blocks, bold/italic inside a `richText` clause. Every pause in typing
   becomes one Edit op (`src/editor/doc-ops.ts` maps the editor's document onto the session's tree), so
   the op log stays at the granularity a human would recognize. The atoms — party header, key/value
   table, signatures — are **node views with a small form** rather than typeable text; a Custom block is
   read-only; an article's number is a CSS decoration, not a character. Undo/redo in the editor toolbar
   are the **session's**: there is one history, and ProseMirror's own is deliberately not installed.
3. Or switch to **Preview** and **click a block** — every block addresses itself with `data-path`, which
   is the selection unit — and edit its fields in the form: text, per-block alignment/indent, a
   `richText` node as a **markdown subset** (`**bold**`, `*italic*`), party fields, key-value cells,
   signature places, list items, plus move / insert / remove. Both editors drive the same session, so
   switching between them mid-edit changes nothing. What is *not* offered is deliberate: article
   numbering, `page` setup and Custom-block props are not editable (a Custom block can only be removed
   or moved), and articles are not inserted or moved.
4. **Undo / redo** any of it, and anchor **comments** to the selected block — they rebase through later
   ops, orphan when their block is removed, and come back on undo.
5. Switch the right panel between **Write**, **Preview**, **Redline** (inline `<ins>`/`<del>`) and
   **Review** (the same document with the comments in the margin). Neither view is an export path — a
   comment can never leak into a PDF/DOCX/HTML export.
6. **Export** HTML / PDF / DOCX. The browser posts the *Edit set*, never a document: the server
   validates it against the stored base, builds the edited Snapshot and renders that.
7. **Re-render edited Snapshot** and the result is byte-identical to the HTML export; **Re-render base**
   still produces the original document. (The Edit tab deliberately uses the default Theme on both
   sides, so "byte-identical" means what it says.)

A rejected edit is shown, not thrown: an op that no longer applies names the **op index** and the tree
path (`op 1 (setText) at /body/99/text: …`), and a malformed op comes back as zod issues under
`ops/<index>`. `tests/demo-api.test.ts` covers the round trip and both failures.

### The WYSIWYG half

ProseMirror is the demo's dependency, never the library's: `@petrpus/legal-docs/edit` stays
editor-agnostic (ADR-0014) and a guard test fails the build if a `prosemirror`/`tiptap` import ever
appears under `src/`. Four files carry the editor, all under `src/editor/`:

| File | What it is |
| --- | --- |
| `pm-schema.ts` | The lossless ProseMirror model of a `DocumentTree` — `treeToPmDoc` / `pmDocToTree`, proved by a fast-check round-trip property against the library's `normalizeTree`. |
| `doc-ops.ts` | The editor→session mapping: `opsBetween(before, after)` aligns the two documents with the library's own `lcsAlign` and emits the Edit ops that reconcile them; `treePathAt` answers "which block is the caret in". |
| `tiptap-extensions.ts` | The TipTap extensions, **generated** from `pm-schema.ts`'s specs so the editor's schema cannot drift from the mapped one (a test derives both and compares them). |
| `Editor.tsx` | The React shell — React node views for the atoms, the toolbar, and the debounce/re-projection loop that keeps the session the single source of truth. |

A reorder reads as a removal and an insertion, never as `moveNode`: two positional documents cannot tell
"this block moved" from "it was deleted here and retyped there", and the audit trail should not guess.
`moveNode` is what the explicit ↑/↓ commands emit, where the human said which block moved.

`src/editor/doc-ops.test.ts` drives a **headless** `EditorState` (typing, pasting marked content,
splitting, joining, reordering, undo/redo) and pins the ops each produces;
`src/editor/tiptap-extensions.test.ts` derives TipTap's schema and compares it with the mapped one node
for node; `src/editor/wysiwyg-export.test.ts` takes the editor's Edit set through an edited Snapshot into
HTML, PDF and DOCX. All three run under the repo-root `npm run verify`.

## A note on safety

The preview uses `dangerouslySetInnerHTML` on the library's HTML output. That is safe **here** because
the renderer escapes all core-emitted text (incl. the payload you type), and the one Custom block in
this demo (`signature-grid`) escapes its own data with the library's `escapeHtml`. A Custom block's
HTML output is inserted **raw** and trusted — if you register one that emits unescaped user input, or
feed user-authored templates, you reintroduce an XSS surface. Sanitize accordingly.

## Deploy

The demo can run anywhere as a small Node server — fully interactive (render, theme editor, clause
editor, diff, edit before export), not a static export (PDF/DOCX rendering is Node-only).

**Build once** (from the repo root):

```sh
npm install && npm run build                              # the library
cd examples/demo && npm install && npm run build           # the client (vite build)
```

**Run the standalone server** (serves the built client + the same `/api/*` logic as `npm run dev`):

```sh
npm run serve            # PORT env var, default 8080 → http://localhost:8080
```

**Docker** — build context must be the **repo root** (the demo consumes `../../dist` and
`../../legal-docs`):

```sh
docker build -f examples/demo/Dockerfile -t legal-docs-demo .
docker run -p 8080:8080 legal-docs-demo
```

Push that image to any container host — Fly.io (`fly launch` pointed at the Dockerfile), Render (a
Docker web service), a VPS (`docker run` behind a reverse proxy), etc.

> **One instance only.** The Clause editor's drafts live in the in-memory `MemoryEditableCatalogStore`,
> and the Edit tab's Snapshots in a plain `Map` — neither survives a restart or is shared across
> replicas. Don't scale this deploy to multiple instances/autoscaling; for persistent, multi-instance
> editing, swap in the `node:sqlite` adapter (`adapters/sqlite/`), which passes the same conformance
> suite. A real app would persist Snapshots in its own document store the same way.

## Notes

- The **Render** and **Clause diff** tabs read the file-based sample catalog (`Catalog.fromDir`).
- The **Clause editor** tab uses a separate in-memory editable catalog (`MemoryEditableCatalogStore` via
  `Catalog.fromStore`), so its edits are isolated from the sample catalog and reset when the dev server
  restarts. The persistent alternative is the `node:sqlite` adapter in
  [`../../adapters/sqlite/`](../../adapters/sqlite/).
