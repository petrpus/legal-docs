# Changelog

All notable changes to `@petrpus/legal-docs` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/) once published.

## [Unreleased]

Post-generation editing layer, in progress. PRD
[#147](https://github.com/petrpus/legal-docs/issues/147).

### Added
- **Runtime validation of the `DocumentTree`** ([#148](https://github.com/petrpus/legal-docs/issues/148)) —
  a zod mirror of the node union (`documentTreeSchema`, `documentNodeSchema`, `richTextV1Schema`) and
  `assertValidTree(value)`, which throws a path-precise `TreeValidationError` carrying every issue
  (`{ path, message }`). Schemas are plain, never strict: a tree written by a newer build still
  validates, and a `custom` node's `props` stays opaque (ADR-0005).
- **The node-kind list as data** — public `DOCUMENT_NODE_KINDS`, `DocumentNodeKind`,
  `isDocumentNodeKind` and `MARK_VALUES`, kept in lockstep with the TypeScript union at compile time
  and with the schema at runtime.
- **`exportDocumentTreeSchema(options?)`** — JSON Schema (draft-7 by default, `draft-2020-12` on
  request) for the document tree itself, alongside the existing payload export; the article/list
  recursion is hoisted into a `documentNodeList` definition.
- **Tree paths** ([#149](https://github.com/petrpus/legal-docs/issues/149)) — a place in a document
  tree is addressed by an array of keys and indices (`["body", 2, "heading"]`) with the canonical
  string form `/body/2/heading` (`formatTreePath` / `parseTreePath`). `locate(tree, path)` is the
  single definition of the editable surface and refuses anything outside it — article numbering,
  `custom` props, page setup, a node's `kind` — with an `EditError` naming the path and a reason.
  `transformPath(path, op)` shifts a path through an insert/remove/move (`null` when it was removed).
- **The Edit set model** — the `EditOp` union (`setText`, `setRichText`, `setStyle`, `replaceNode`,
  `insertNode`, `removeNode`, `moveNode`, `insertListItem`, `removeListItem`, `setFurniture`), the
  `Comment` shape and the `EditSet` envelope `{ schemaVersion, baseSnapshotId, ops, comments?, author?,
  at?, note? }`, each with a zod schema, `assertValidEditSet` and `exportEditSetSchema()`. A `custom`
  block cannot be inserted or replaced (ADR-0005).
- **`applyEdits(tree, ops)` / `applyEdit(tree, op)`** — pure (the input tree is never mutated),
  sequential, validating the tree before and after, and never writing `undefined` keys, so an edit
  that restores the original yields a deep-equal tree. Browser-safe by construction — the whole module
  graph is scanned by a guard test — and re-exported from the browser entry.
- **The whole op set applies** ([#151](https://github.com/petrpus/legal-docs/issues/151)) —
  `setRichText`, `setStyle` (a partial `indent` replaces the whole override; `null` clears it),
  `replaceNode`, `insertNode`, `removeNode`, `moveNode`, `insertListItem`, `removeListItem` and
  `setFurniture` join `setText`. An insert addresses a *position*, so an index equal to the list
  length appends; `removeNode`/`moveNode` are kind-agnostic (a `custom` block can be moved out of the
  way but never rewritten); an inserted article keeps the number the caller supplied, because
  numbering is never recomputed. A compound edit using every op kind renders to HTML, PDF and DOCX.
- **The edited Snapshot** ([#150](https://github.com/petrpus/legal-docs/issues/150), ADR-0014) — an
  edited document is a first-class `Snapshot`. `buildEditedSnapshot(base, edits)` applies an Edit set
  to a tree-bearing base and returns a `tree`-mode Snapshot with its own deterministic id and
  `derivedFrom: EditSet`, inheriting the base's template/version/variant/locale and its provenance
  (payload, resolved payload, Clause pins). A `pins`-mode base, an Edit set naming another Snapshot and
  a malformed Edit set are rejected with typed errors; the base object is never mutated; editing an
  edited Snapshot chains.
- **`verifyEditedSnapshot(base, edited)`** — the audit check: re-applies the Edit set and compares the
  record field by field, reporting a typed `issue` (`tree-mismatch`, `id-mismatch`, `base-mismatch`,
  `not-applicable`, `metadata-mismatch`, `not-derived`) instead of throwing.
- **`renderEdited({ snapshot, edits, format, … })`** — export a document with an Edit set applied and
  get the edited Snapshot back. The edit is frozen as a Snapshot before rendering, so
  `renderFromSnapshot(result.snapshot)` reproduces the export exactly, in PDF, HTML and DOCX.
- **`diffTree(base, edited)`** ([#152](https://github.com/petrpus/legal-docs/issues/152), ADR-0014) —
  the flat, path-addressed list of what an edit did: `inserted` / `removed` nodes, `insertedItem` /
  `removedItem` list items, and `text`, `richText` and `attr` changes, each at the path where it
  happened. Identical trees produce an empty list. Node lists align on structural equality and changed
  runs pair positionally, so a reworded paragraph reads as a rewording; a pair that cannot be
  reconciled in place — different kinds, a different article `no`/`level` or party `kind`, a different
  row/place count, any change inside an opaque `custom` block, and every **move** — degrades to a
  removal plus an insertion. A change is reported at its path in the edited tree; a removal keeps its
  base-tree path.
- **`buildRedline(base, edited)` → `RedlineDoc`** — one renderer-agnostic description of an edit: the
  edited document mirrored block by block (`unchanged`, `inserted`, `deleted`, `textChanged`,
  `attrsChanged`, `container`), deleted blocks kept in place, changed strings carrying word-level
  segments, changed rich text carrying per-paragraph runs whose marks come from the after side except
  on a deletion, page-furniture changes per slot, plus a `stats` tally. The HTML and DOCX redline
  renderers will both be visitors over this structure, and `diffTree` is its flattening.
- **`diffWords(before, after)`** — word-level inline diff (`equal` / `ins` / `del` segments).
  Whitespace runs are tokens of their own, so the segments reassemble both inputs exactly, with no
  normalisation; non-ASCII and astral-plane text survive untouched.
- **`renderTreeToHtml(tree, { emitPaths: true })`** ([#153](https://github.com/petrpus/legal-docs/issues/153)) —
  opt-in `data-path` attributes carrying the canonical tree path (`/body/5/items/0`) on every block
  element: title, paragraph, rich-text container, article (and every nested article body), list and
  list item, party header, key-value table, signatures, and a Custom block (whose own markup is
  wrapped, never rewritten). A UI maps a click in the rendered document back to an editable location
  this way. Off by default, so exported documents carry no editing metadata and the default output is
  byte-identical.
- **`renderNodeToHtml(node, cx, path)` / `createHtmlRenderContext(options)`** — the HTML Renderer's
  per-node step and its resolved context, exported so the redline and review Renderers render an
  untouched node exactly as a plain render does.
- **`createEditSession(init)`** ([#154](https://github.com/petrpus/legal-docs/issues/154), ADR-0014) —
  the framework-agnostic editing state an editor UI drives: `apply(op)` (a typed `{ ok }` result — an
  op that does not fit the tree is an answer, not an exception — truncating the redo tail),
  `undo`/`redo`/`canUndo`/`canRedo`, `getNode(path)`, `preview()` (HTML with `data-path`),
  `toEditSet()` and `subscribe(listener)` for `useSyncExternalStore`. History is an op log plus a
  cursor with every prefix memoized, so `session.tree` is a new reference exactly when the document
  changed. A session starts from a base Snapshot or a bare tree, resumes from a stored Edit set, and
  refuses a `pins`-mode base or an Edit set naming another Snapshot.
- **`@petrpus/legal-docs/edit`** — a new browser-safe subpath export carrying the session, the Edit set
  model, tree paths, `applyEdits`, the tree diff / redline model and the HTML Renderer. Built as its
  own bundle so it shares no chunk with the Node-only half of the package; guard tests assert the
  built bundle imports no `node:` built-in, and that nothing under `src/**` imports ProseMirror or
  TipTap (a WYSIWYG binds to the session from outside).
- **`richTextToMarkdown(value)`** — the inverse of `parseRichText` for the bold/italic subset, so a
  form editor can offer a `richText` node as a plain textarea. Also `assertValidEditOp(value)`, the
  single-op counterpart of `assertValidEditSet`.
- **Comments anchored to tree paths** ([#155](https://github.com/petrpus/legal-docs/issues/155),
  ADR-0014) — `session.addComment/editComment/resolveComment/removeComment` and `session.comments`,
  whose anchors are *derived* from `originalPath` + `anchoredAfterOp` by replaying the op log: an
  insert before a comment shifts it, removing its node orphans it (`path: null`), and undoing that
  removal brings it back. Comments are not on the undo stack, and they round-trip through
  `EditSet.comments`. The quote captured at anchoring time flags a note whose text has since changed.
- **`renderReviewHtml(tree, comments, options)`** — the preview with the comments as CSS-only margin
  notes (quote, author, time, and resolved / orphaned / outdated-quote flags), also reachable as
  `session.reviewHtml()`. It wraps the plain `emitPaths` render byte for byte and no exporter goes
  through it, so PDF, DOCX and plain HTML never contain a comment. Helpers `quoteAt`, `nodeText`,
  `deriveCommentPath` and `isCommentStale` are exported for a UI that renders its own review view.
- **`renderRedlineHtml(redline, options)`** ([#156](https://github.com/petrpus/legal-docs/issues/156),
  ADR-0014) — the inline redline: the edited document as it now reads, with `<ins>`/`<del>` around the
  words that moved and block-level markers for an insertion, a deletion, a dropped or added list item
  and a presentation-only change. It renders a `RedlineDoc` (`buildRedline`), so it and the DOCX
  compare export describe the same edit. An untouched block goes through the plain Renderer itself, so
  a redline of an unedited document is the document; changed page-header/footer slots are reported as
  a trailing section. Also reachable as `session.redline()` / `session.redlineHtml()`, on the
  `./edit` subpath and on the browser entry. `mode` reserves a future side-by-side layout.
- **An ADR index** ([`docs/adr/README.md`](./docs/adr/README.md)) listing every decision record.
- **"Edit before export" in the demo** ([#157](https://github.com/petrpus/legal-docs/issues/157),
  ADR-0014) — the first end-to-end product flow over the editing layer, and the reference shape for the
  three routes a consuming app needs: `POST /api/edit/start` freezes and stores a `full` base Snapshot
  and hands the browser its tree, `POST /api/edit/export` validates the posted **Edit set**, builds and
  stores the edited Snapshot and renders *it* (HTML/PDF/DOCX), and `POST /api/edit/rerender` re-renders
  either stored Snapshot. The wire carries ops, never a document, so no exported file exists without
  the audit record that reproduces it — the demo's re-render button shows the edited Snapshot
  reproducing the export byte for byte, and the base still rendering the original. The client is the
  first consumer of the `@petrpus/legal-docs/edit` subpath: a form editor over `data-path` block
  selection with undo/redo, comments and the Preview / Redline / Review views.

### Changed
- **`Snapshot` gained an optional `derivedFrom`** ([#150](https://github.com/petrpus/legal-docs/issues/150)) —
  present only on an edited Snapshot, validated by `assertValidSnapshot` and refused on a `pins`-mode
  snapshot. The id digest mixes in the base Snapshot id (and only that) for a derived snapshot, so
  every existing id and `SNAPSHOT_SCHEMA_VERSION` (2) are unchanged — an optional additive field is not
  a breaking shape change.
- **`assertValidSnapshot` now validates the tree of a `full`/`tree`-mode snapshot against the schema**,
  so a persisted snapshot with a malformed node is rejected by path (`body.1.kind: …`) instead of
  failing deep inside a renderer. Snapshot ids, `SNAPSHOT_SCHEMA_VERSION` (2) and the existing
  "no tree body array" / `schemaVersion` errors are unchanged.
- **The Clause paragraph diff now shares its alignment with the tree diff**
  ([#152](https://github.com/petrpus/legal-docs/issues/152)) — the LCS and the positional pairing moved
  into `src/core/text-diff.ts` as the generic `lcsAlign` / `pairAligned`. `diffRichText`'s output is
  unchanged.

## [0.2.0-beta.2] — 2026-09-19

### Fixed
- **Characters silently dropped from PDF output across renders in one process.** fontkit memoises
  `Glyph` objects on each loaded font and pdfkit writes subset state into them while embedding, while
  react-pdf keeps loaded fonts as process-wide singletons — so a glyph first cached by one document
  reached the next document needing the same character carrying a stale subset id, and that
  document's subset mapped it one slot off. Reliably seeded by a capital with an acute accent
  (`Í`, `Ý`); affected every embedded TrueType family, this library's output and the host's alike.
  `renderTreeToPdf` now clears the glyph cache on every registered font before and after rendering
  (new public `clearGlyphCaches`). [#163](https://github.com/petrpus/legal-docs/issues/163)

## [0.2.0-beta.1] — 2026-07-12

Page geometry across the paged renderers (ADR-0013): named formats, orientation, and template-level
page requirements. PRD [#135](https://github.com/petrpus/legal-docs/issues/135), PRs #140–#144.

> Briefly published as `0.1.0-beta.2` and renumbered the same day (a new feature bumps the minor);
> the deprecated `0.1.0-beta.2` artifact is content-identical.

### Added
- **Six named page formats** — `theme.page.size` widens from `A4 | LETTER` to
  `A3 | A4 | A5 | LETTER | LEGAL | TABLOID`, and `theme.page` gains
  `orientation: "portrait" | "landscape"` (defaults unchanged: A4 portrait, 48 pt padding).
- **One core dimension table** — new public `PAGE_SIZES` (points, portrait reference; values match
  react-pdf's internal table), `effectivePage(theme, override)` precedence helper, `isPageSizeName`
  guard, and the `PageSizeName` / `PageOrientation` / `PageSetup` types.
- **Template-level `page:`** — a YAML template may declare
  `page: { size?, orientation? }` (static enums, validated at catalog load) as a content requirement
  that **overrides the theme per-field** in both paged renderers. Carried onto the `DocumentTree`,
  frozen in the Snapshot (additive — the digest mixes `page` in only when present, so existing
  documents keep their snapshot ids; schema stays v2), and reproduced by `renderFromSnapshot`.
- **Demo** — the theme editor offers all six formats and both orientations as selects.

### Changed
- **DOCX now emits explicit section page geometry** — `w:pgSz` (size + orientation) and `w:pgMar`
  mapped from `theme.page.padding` on all four edges. Previously the section carried no page
  properties and Word applied its own defaults (Letter-ish size, 1-inch margins) regardless of the
  theme; default-theme DOCX margins therefore shift from 1440 to 960 twips. PDF/DOCX geometry can no
  longer drift (shared `PAGE_SIZES`).
- HTML remains a page-less fragment and ignores page geometry (ADR-0006/0011), now documented
  alongside the new **Page setup** term in CONTEXT.md, AUTHORING.md, and THEMING.md.

## [0.1.0-beta.1] — 2026-07-11

First published pre-release: `npm install @petrpus/legal-docs@beta`. Everything below was built
phase by phase from the approved design plan ([`docs/PLAN.md`](docs/PLAN.md)) and ships in this beta.

### Documentation site redesign & live in-browser demo (ADR-0012)
- **`docs/live-demo.html`** — a genuinely interactive demo: edit a JSON payload, the document re-renders
  entirely client-side, no server. Powered by a new browser-safe build entry (`src/browser.ts`, bundled
  standalone into `docs/assets/browser-demo.js` by a second `tsup` config) that excludes `FileCatalogStore`
  (`node:fs`), the Snapshot audit trail (`node:crypto`), and the PDF/DOCX renderers. Template/Clause
  resolution (variant composition, `@latest`) is shared with `Catalog` via the new
  `src/catalog/resolve.ts`, so the browser path and the Node path can't drift apart.
- **The public doc site is scoped down** to a project introduction, developer reference, and a live
  demo — the 11 ADRs, `docs/PLAN.md`, and `CONTRIBUTING.md` are no longer generated as site pages (they
  stay in the repo and are linked to on GitHub from any page that references them). See ADR-0012 for the
  rationale.

### LLM drafting recipe (Wave 5 #4)
- **[`docs/recipes/llm-drafting.md`](docs/recipes/llm-drafting.md)** — docs only, no code change. Shows
  an LLM producing clause text that flows through the existing runtime editing API exactly as a human
  editor's draft would: `createDraft → previewDiff (human review) → validate()-gated publish`. The
  `validate()` gate is the guardrail for AI-authored content, not a new mechanism — a bad LLM draft is
  blocked with the same structured `PublishValidationError` findings a bad human draft would produce.
  Core stays free of any AI/HTTP dependency; the recipe uses `@anthropic-ai/sdk` as the consumer's own
  dependency.

### Deploy-ready demo server (Wave 5 #3)
- **The demo can now run as a small, fully-interactive Node server anywhere** — not just under `vite
  dev`. The `/api/*` render/diff/schema/editor logic was extracted into a framework-agnostic
  `examples/demo/server/api.mjs` (`createApiHandler({ lib, catalogDir })`), shared by both the Vite dev
  plugin and a new standalone `examples/demo/server.mjs` (plain `node:http`, no new dependency; serves
  the built client + the same API; `PORT` env, default `8080`).
- A multi-stage `examples/demo/Dockerfile` (build context = repo root) builds the library, the demo
  client, and runs `server.mjs`; a `docs`/README section covers `docker run` / Fly / Render deployment
  and flags the in-memory editing store as single-instance-only (the `node:sqlite` adapter is the
  persistent alternative).
- `examples/demo/server/api.mjs` adds a request-body size cap (1 MB) the original dev-only plugin
  flagged as needed hardening for anything beyond a trusted local browser.

### GitHub Action (Wave 5 #2)
- **A composite `actions/validate/` GitHub Action** wraps `legal-docs validate --github` as a drop-in PR
  check: `uses: petrpus/legal-docs/actions/validate@main` with `{ catalog, config? }` inputs. Since the
  package isn't published to npm yet, the action builds the library from the checked-out repo itself
  (documented as a temporary cost in `actions/validate/README.md` — collapses to `npm i
  @petrpus/legal-docs` once published). CI gains an `action-self-test` job exercising the action
  end-to-end via `uses: ./actions/validate`.

### CLI (Wave 5 #1)
- **A `legal-docs` command-line bin** (`legal-docs render|validate|schema`), built as a second tsup
  entry alongside the library (`dist/cli.js`, `package.json#bin`). Three subcommands, all over the
  existing public API — no new library capability:
  - `legal-docs render <template> --catalog <dir> [--data f.json] [--variant] [--locale]
    [--format pdf|html|docx] [--out file|-] [--config registry.mjs]`
  - `legal-docs validate --catalog <dir> [--config registry.mjs] [--github]` — exits `1` with findings
    printed as `path: message`; `--github` additionally emits message-only `::error` workflow
    annotations (percent-encoded; no `file=`, since a finding's `path` is a logical catalog path, not a
    filesystem path).
  - `legal-docs schema <template> --catalog <dir> --config registry.mjs [--variant] [--target
    draft-7|draft-2020-12]` — prints the template's payload JSON Schema (via `exportPayloadSchema`).
  - `--config` points at a plain ESM module exporting any of `{ schemas, derivations, customBlocks,
    helpers, degradation }` — the code-side registries a Catalog's templates may reference (ADR-0004);
    every command works without it for templates that need none.

### Phase 1 — MVP core + PDF
- Renderer-agnostic document tree (`DocumentNode[]`); the closed Core node set.
- Declarative Template engine: `$path` / `{{ expr }}` binding, `if` / `for`, whitelisted helpers via a
  safe expression engine (no `eval`).
- Payload validation (zod) and the deterministic **Resolve phase** (Derivations → `$derived.*`).
- Rich-text model (`RichTextV1`); Clauses with `@vN` / `@latest` references.
- File catalog (`Catalog.fromDir`, `FileCatalogStore`) + integrity lint (`validate()`).
- PDF renderer (`@react-pdf/renderer`) + a sample catalog and golden tests.

### Phase 2 — Variants, Snapshot & Clause diff
- **Includes** (shared template fragments); **Template families / Base / Slots / Variants**
  (composition before tree assembly).
- Real **Snapshot** record with `full` / `tree` / `pins` modes (ADR-0003) and
  `renderFromSnapshot` for deterministic re-render.
- Structured **Clause diff** (`catalog.clauses.diff`).

### Phase 3 — Custom block escape hatch (ADR-0005)
- The `custom` node + body item; deep-bound props.
- Code-side **Custom-block registry**, the **Degradation contract**
  (`placeholder` / `throw`), and integrity-lint for custom blocks.
- A product-agnostic signature-grid example.

### Phase 4 — HTML renderer (ADR-0006)
- HTML renderer (a string visitor; no react-dom) emitting a scoped `<div class="legal-doc">` fragment;
  centralized escaping.
- `format`-discriminated `renderDocument` / `renderFromSnapshot` result (pdf/html).
- `renderClauseDiff` — an HTML view of a Clause diff. The Degradation contract goes live for HTML.

### Phase 5 — DOCX renderer (ADR-0007)
- DOCX renderer (the `docx` package) with a flat block model; `format: "docx"` returns a binary buffer.
- Theme→DOCX unit helpers (`halfPoints` / `twips` / `eighths`); a docx Custom-block slot.

### Phase 6 — Locale & public-ready packaging
- Per-render **`locale`** override (with the store's fallback); pins freeze the resolved locale.
- Rich README, `docs/THEMING.md`, packaging metadata, `CHANGELOG`, `CONTRIBUTING`.

### Block-level styling (ADR-0008)
- **Text alignment** on `title`/`paragraph` — `left | center | right | justify` — as both a Theme
  default (`theme.align.{title,paragraph}`) and a per-block authoring override that wins over it.
- **Indentation** on `title`/`paragraph` — first-line (`firstLineIndent`) and block left (`indent`),
  in design points — with Theme paragraph defaults (`theme.indent.{firstLine,block}`) and per-block
  overrides. PDF `textIndent`/`marginLeft`, HTML `text-indent`/`margin-left`, DOCX `w:ind` (twips).
- Authoring gains an object form: `- title: { text, align, indent, firstLineIndent }` (the string
  shorthand is unchanged and equivalent); styling props are guarded to their types at assembly (engine
  throw + catalog-lint finding). `defaultTheme` stays all-`left`/zero-indent, so existing output is
  unchanged.

### Phase 7 — runtime editing API (ADR-0009)
- The editing **contract**: `EditableCatalogStore` extends the read-only `CatalogStore` with drafting,
  a `draft → in_review → published` workflow, and an `AuditEntry` edit log. Read methods surface only
  published content, so `@latest` = newest published with `FileCatalogStore` unchanged.
- `MemoryCatalogStore` + `MemoryEditableCatalogStore` — the reference editable store, covering **all
  five element kinds**: clauses (versions-as-rows, per-locale, additive translations), templates/bases
  (single-revision; publish bumps the version), and includes/variants (versionless). `Catalog.fromStore`
  gains its first test coverage (parity vs `fromDir`).
- `catalog.editing` — the runtime editing API with a **`validate()`-gated, composition-aware publish**
  (a draft that would break a consuming template, or a variant with an undeclared-slot override, is
  blocked with `PublishValidationError`) and `previewDiff` review diffs.
- A **`node:sqlite` adapter** (`adapters/sqlite/`, outside the package) and the shared `EditingWorkflow`
  behind both stores, pinned by a conformance suite run against both. A guard keeps `src/**` DB-free.
- A **runtime Clause editor** in the demo (`examples/demo/` Editor tab).

### Module layout & Custom block
- **`Theme` and the `CustomBlock` contract moved out of `render-pdf/`** to top-level `src/theme.ts` and
  `src/custom-block.ts` — they are cross-renderer concerns, so the HTML/DOCX renderers no longer import
  from the PDF module (the dependency inversion is gone). Public imports are unchanged (both re-exported
  from the package root).
- **`CustomBlock.pdf` is now optional** — all three format slots are optional; register only the formats
  you render (a missing one degrades). An HTML-only app no longer has to author a react-pdf `pdf` impl.

### Renderer API
- The three tree renderers now share a coherent triad and a single options object: **`renderTreeToPdf`**
  (renamed from the return-type-named `renderTreeToBuffer` and now **exported**), `renderTreeToHtml`,
  `renderTreeToDocx` — each `(tree, options?: RenderTreeOptions)` where `RenderTreeOptions` is
  `{ theme?, customBlocks?, degradation?, onDegrade? }` (was five positional params). A consumer holding
  a `DocumentTree` can now render all three advertised formats.

### Page headers, footers & numbering (ADR-0011)
- **Paged output (PDF) now supports running page headers/footers with page numbering.** A Template gains
  optional `header` / `footer`, each a `{ left?, center?, right? }` of interpolated slots — bind the
  payload (`{{ $party.name }}`) and place page numbers with the reserved `{{ $page.number }}` /
  `{{ $page.total }}` tokens (*"Confidential — {{ $page.number }} / {{ $page.total }}"*). Presentation is
  a new `theme.header` / `theme.footer` group (`fontSize`, `color`, `margin`).
- **`DocumentTree` is now `{ body, header?, footer? }`** (was `DocumentNode[]`), so resolved furniture is
  frozen in the Snapshot and re-renders deterministically. The tree renderers accept `DocumentTree | DocumentNode[]`
  (a bare array is normalized via the new `asDocumentTree`), so a caller holding a node array is unaffected.
  New engine entry `assembleDocument` resolves body + furniture (`assembleTree` still returns the body).
- **`SNAPSHOT_SCHEMA_VERSION` → 2** (the `tree` field shape changed); a furniture-less document keeps its
  v1 snapshot id (the digest only mixes in header/footer when present).
- **DOCX** renders furniture as a section `Header`/`Footer` with a three-column tab-stop layout; page
  numbers become native Word `PAGE`/`NUMPAGES` fields (so they stay live if the document is edited).
- **HTML ignores furniture** — it is a page-less fragment, so headers/footers are paged-output-only
  (PDF/DOCX), exactly as HTML already ignores `theme.page.*`.

### Locale-aware helpers (ADR-0010)
- **New opt-in locale-aware helpers** — `formatDateLong` (`Intl.DateTimeFormat`, e.g. *"1. července 2026"*)
  and `formatMoney` (`Intl.NumberFormat` currency, e.g. *"1 000,00 €"*), formatted for the **render
  locale**. The engine binds the resolved locale into the built-ins via a new `makeDefaultHelpers(locale)`
  (also exported); the public `Helper`/`EvalContext` types are unchanged (locale is bound by closure, not
  a new argument). The deterministic `formatDate` (ISO) / `formatCurrency` (naive) are **unchanged** and
  remain the audit-stable default — the `Intl` helpers are kept out of byte-stable golden artifacts
  because their output is locale- and ICU-version-dependent.

### JSON Schema export
- **Payload schemas can be exported to JSON Schema** for external tooling (form builders, validators,
  API gateways) that shouldn't depend on zod. `exportPayloadSchema(schema, opts?)` converts one zod
  schema; `exportPayloadSchemas(registry, opts?)` converts a whole `PayloadSchemaRegistry`, keyed by the
  same names Templates reference. Built on zod v4's native `z.toJSONSchema`. Defaults to **draft-7**
  (broadest tooling support); pass `{ target: "draft-2020-12" }` for the modern dialect. A schema zod
  can't represent (e.g. one with a transform) fails with a `LegalDocsError` naming the offending key.

### Malformed-YAML handling
- **A syntactically-broken catalog YAML file now fails with a typed `LegalDocsError`** that names the
  offending file (`Malformed YAML in <path>: <reason>`), instead of letting the `yaml` library's raw
  `YAMLParseError` escape untyped and without file context. All five `FileCatalogStore` load paths
  (template, base, variant, include, clause) route through one wrapper; the original parser error is
  preserved as `cause`.

### Expression arithmetic safety
- **Division/modulo by zero and non-finite arithmetic are now hard errors** (`ExpressionError`) instead
  of silently leaking. `$x / 0` (→ `Infinity`), `0 / 0` (→ `NaN`), and `$x % 0` previously flowed
  through `String(value)` and rendered literally as the text *"Infinity"* / *"NaN"* in a document.
  `toNumber` now also rejects a non-finite **operand** (a literal or coerced `Infinity`), and every
  arithmetic result is guarded so a finite-operand overflow can't leak either.

### Partial theme override
- **`theme` now accepts a partial** everywhere it is taken (`renderDocument`, `renderFromSnapshot`, the
  three tree renderers) — a `DeepPartial<Theme>` deep-merged over `defaultTheme` by the new **`mergeTheme`**
  helper. Override a single token (`theme: { fontSize: { title: 22 } }`) without re-spreading every
  group. Arrays (e.g. `article.headingFontSize`) are replaced wholesale, not element-merged. `mergeTheme`
  and the `DeepPartial` type are exported.

### Catalog enumeration
- `CatalogStore` and `Catalog` gain **`clauseIds()`** and **`includeIds()`**, and `Catalog.clauseVersions(id)`
  is now public — you can list clauses/includes without already knowing their ids (implemented across the
  file, memory, and sqlite stores). The demo editor drops its manual id-tracking workaround as a result.

### Error taxonomy
- Every error the library throws now extends **`LegalDocsError`** — catch it to handle any library
  failure. **`NotFoundError`** (a subclass) carries a structured `{ kind, ref }` so a consumer can map a
  missing template/clause/include/base/variant/schema/draft/pin to e.g. an HTTP 404 without
  string-matching messages. The seven existing error classes (`PayloadValidationError`,
  `PublishValidationError`, `VarsValidationError`, `ExpressionError`, `IncludeError`, `CompositionError`,
  `SnapshotError`) are rebased onto the base; every previously-plain `throw new Error` in the stores,
  facades, engine, and renderers is now typed.

### Snapshot format versioning
- `Snapshot` now carries a **`schemaVersion`** (`SNAPSHOT_SCHEMA_VERSION`); `renderFromSnapshot`
  validates it up front and rejects an unknown-version / malformed snapshot with a clear `SnapshotError`
  instead of failing obscurely inside a renderer. Cheap insurance for a persisted legal-audit artifact.

### Fonts & diacritics
- **PDF now renders Latin-Extended diacritics correctly.** react-pdf's built-in Helvetica mangled Czech
  (*"Příliš žluťoučký kůň"* → *"PYíliš žlueou ký koH"*); the library bundles a diacritics-safe serif
  (Liberation Serif, SIL OFL) and registers it by default. New `theme.font.family` token (honoured by
  all three renderers); `Font` (react-pdf) and `registerBundledFonts` re-exported so consumers can
  register their own. See docs/THEMING.md.

[Unreleased]: https://github.com/petrpus/legal-docs/compare/v0.2.0-beta.2...HEAD
[0.2.0-beta.2]: https://github.com/petrpus/legal-docs/compare/v0.2.0-beta.1...v0.2.0-beta.2
[0.2.0-beta.1]: https://github.com/petrpus/legal-docs/compare/v0.1.0-beta.1...v0.2.0-beta.1
[0.1.0-beta.1]: https://github.com/petrpus/legal-docs/releases/tag/v0.1.0-beta.1
