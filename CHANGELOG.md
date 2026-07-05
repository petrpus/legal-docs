# Changelog

All notable changes to `@petrpus/legal-docs` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/) once published.

## [Unreleased]

The library was built phase by phase from the approved design plan ([`docs/PLAN.md`](docs/PLAN.md)).
It is **feature-complete and publish-ready** but not yet published to npm.

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

### Phase 7 — runtime editing API (in progress, ADR-0009)
- The editing **contract**: `EditableCatalogStore` extends the read-only `CatalogStore` with drafting,
  a `draft → in_review → published` workflow, and an `AuditEntry` edit log. Read methods surface only
  published content, so `@latest` = newest published with `FileCatalogStore` unchanged.
- `MemoryCatalogStore` (in-memory read store) + `MemoryEditableCatalogStore` — the reference editable
  store, covering **clauses** (versions-as-rows, per-locale, additive translations) and
  **templates / includes** (single-revision; publish bumps a template's version). `Catalog.fromStore`
  gains its first test coverage (parity vs `fromDir`).
- `catalog.editing` — the runtime editing API with a **`validate()`-gated publish** (a draft that would
  break a consuming template is blocked with `PublishValidationError`) and `previewDiff` review diffs.

[Unreleased]: https://github.com/petrpus/legal-docs
