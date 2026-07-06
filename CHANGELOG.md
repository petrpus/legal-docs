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

[Unreleased]: https://github.com/petrpus/legal-docs
