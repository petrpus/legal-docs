# Page headers, footers & numbering (paged output)

Legal documents routinely need running **page furniture**: a party name or document title in the
header, a confidentiality notice in the footer, and *"Page X of Y"* numbering. None of this was
expressible — the document model was a flat body, and the only page concept lived inside the PDF
renderer's single `<Page>`. This ADR fixes how furniture is authored, resolved, frozen, and rendered.

## Decision

**Authored on the Template, styled by the Theme.** A Template gains optional `header` / `footer`, each
a `{ left?, center?, right? }` of interpolated strings (`PageFurnitureSpec`). Content is document-specific
(so it belongs on the Template, mirroring ADR-0008's per-document override), while presentation
(`fontSize`, `color`, `margin`) is a new `theme.header` / `theme.footer` group (deep-merged by
`mergeTheme` for free). A slot binds the payload like body text: `{{ $party.name }}`, `{{ $date }}`.

**Page numbers via reserved `$page` tokens + sentinels.** `{{ $page.number }}` / `{{ $page.total }}`
are the only per-page values — known to the renderer at paint time, not at assembly. Assembly
interpolates furniture against the payload scope augmented with a reserved `$page = { number, total }`
bound to two private-use-codepoint **sentinels** (exported as `PAGE_NUMBER_SENTINEL` /
`PAGE_TOTAL_SENTINEL` so a downstream renderer can identify them); the resolved slot string carries the
sentinels where page tokens stood. `page` is thus a **reserved** furniture-scope key — inside a
header/footer slot it shadows any payload field named `page` (the body still sees the real one), the
same reservation stance as `$derived` and the `for` loop's `$index`. A paged renderer substitutes them per page (PDF via `<Text render={({pageNumber,
totalPages}) => …}>`, DOCX via `PageNumber` fields). This needs **no** expression-engine change — page
tokens flow through the ordinary `$`-path machinery — and keeps free text and page numbers composable
in one slot (*"Confidential — {{ $page.number }} / {{ $page.total }}"*).

**Frozen in the Snapshot: `DocumentTree` is now an object.** `DocumentTree` changes from a bare
`DocumentNode[]` to `{ body: DocumentNode[]; header?: PageFurniture; footer?: PageFurniture }`, so the
**resolved** furniture rides into the Snapshot's `tree` field automatically and re-renders
deterministically (a `full`/`tree`-mode re-render, and a `pins`-mode re-assembly, both reproduce it).
This bumps `SNAPSHOT_SCHEMA_VERSION` to **2** (v1 array-`tree` snapshots are cleanly rejected). The
snapshot digest hashes the body under the same `tree` key as v1 and only mixes in `header`/`footer` when
present, so a document **without** furniture keeps its v1 id — no gratuitous id churn.

**HTML ignores furniture.** HTML emits a page-less fragment, so headers/footers/page-numbers have no
meaning there — it renders `tree.body` only, exactly as it already ignores `theme.page.*`. Furniture is
**paged-output-only** (PDF/DOCX). This is a deliberate, documented format asymmetry, not a silent drop:
a consumer wanting paged HTML applies CSS paged-media themselves.

**Renderers stay back-compatible.** The three public tree renderers accept `DocumentTree | DocumentNode[]`
and normalize a bare array to `{ body }` via `asDocumentTree` — a caller holding a plain node array (no
furniture) keeps working after the type change.

## Consequences

- New engine entry `assembleDocument(template, ctx): DocumentTree` resolves body **and** furniture;
  `assembleTree` is unchanged (returns `DocumentNode[]`, the body) so the many callers/tests that build
  and assert bodies are untouched. The facade and `renderFromSnapshot` use `assembleDocument`.
- PDF renders furniture as a `fixed`, absolutely-positioned three-column row repeated on every page.
  DOCX furniture (section `Header`/`Footer` + `PageNumber`) lands in a follow-up slice.
- Alternatives rejected: a **furniture DocumentNode** at the top of the body (furniture is not body
  content — every renderer would have to special-case and skip it); **carrying furniture in render
  options** (options aren't frozen, so re-render would lose it); a **separate numbering config** divorced
  from free text (blocks *"Confidential — page 3 of 10"* in one slot); **replacing** `DocumentTree`
  without a normalizer (a breaking change for consumers holding a node array).
