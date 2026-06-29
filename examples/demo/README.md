# legal-docs demo

A minimal **Vite + React** app to try `@petrpus/legal-docs` hands-on: pick a template, switch locale
and format, restyle live via a few **Theme** tokens, edit a typed payload (and watch validation fail),
and view a **Clause diff** rendered to HTML.

## How it works

PDF, DOCX and the file Catalog are **Node-side**, so rendering runs in the Vite **dev server** (a tiny
API in `vite.config.ts`); the browser only sends `{ template, locale, theme, data, format }` and
displays the returned **HTML** (or downloads the **PDF/DOCX** binary). This is the seam a real app puts
behind its own server — the React client never imports the library.

```
React UI ──POST /api/render {template, locale, theme, data, format}──▶ dev-server (Node) ─▶ renderDocument
        ◀──────────────── { html }  or  { base64 } (pdf/docx) ──────────────────────────┘
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

- **Templates** — `hello`, `agreement`, `contract`, `greeting` (typed payload), `localized` (locale-aware).
- **Theme** — change the title/paragraph size and a few colours; re-render and see all formats restyle
  from the one Theme (full token surface in [`../../docs/THEMING.md`](../../docs/THEMING.md)).
- **Locale** — render `localized` in `en` vs `cs` (the per-render `locale` override).
- **Fields & validation** — edit `greeting`'s payload JSON; invalid data fails schema validation and the
  error is shown.
- **Formats** — `html` previews inline; `pdf` / `docx` download.
- **Clause diff** — diff two versions of the `counterparts` Clause, rendered via `renderClauseDiff`.

## A note on safety

The preview uses `dangerouslySetInnerHTML` on the library's HTML output. That is safe **here** because
the renderer escapes all core-emitted text (incl. the payload you type) and only sample templates with
no Custom blocks are used. If you register an HTML Custom block (its output is trusted and inserted
raw) or feed user-authored templates, you reintroduce an XSS surface — sanitize accordingly.

## What this demo does NOT include

Live editing of clauses/templates from the UI (CRUD, draft → publish) is the future **DB-backed
`CatalogStore` + runtime editing API** (roadmap Phase 7). Today the catalog is the file-based sample
catalog; an app could also implement an in-memory `CatalogStore` via `Catalog.fromStore(...)`.
