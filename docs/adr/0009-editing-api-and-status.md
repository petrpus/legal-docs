# A runtime editing API: draft → in-review → published, over the same CatalogStore seam

Until now the catalog is **read-only and file-first**: `CatalogStore` has ten load/resolve methods,
`FileCatalogStore` reads YAML, and content changes happen by editing files and committing them (Git is
the version control and the publish gate). This is right for developers but blocks live editing by
non-developers. Phase 7 adds the **write** side — a runtime editing API with a status workflow and an
edit audit — as **another adapter of the same seam**, exactly as `catalog-store.ts` always anticipated.
This ADR fixes the contract so every adapter (in-memory reference, DB-backed) and the facade agree on
status semantics, immutability, and how `@latest` is affected — and records why the core package stays
DB-free and product-agnostic.

## Decision

**The read-side `CatalogStore` methods surface ONLY published content; drafts are reachable exclusively
through the new editable methods.** This single invariant is load-bearing:
- `Catalog.latestVersion` stays **byte-for-byte unchanged** (`clauseVersions(id).at(-1)`), yet
  `@latest` now means "newest **published**", because `clauseVersions` returns only published versions.
  This finally enforces what ADR-0002 and AUTHORING.md only aspired to ("`@latest` = newest published").
- `FileCatalogStore` is **unchanged**: files are Git-gated, so every present version/locale row is by
  definition published. No new code, no behavior change.
- The only core change for `@latest`=published is this documented invariant on the interface plus the
  new editable stores honoring it. `catalog.ts` `latestVersion` does not change.

**A 3-state workflow per revision: `draft → in_review → published`.** Transitions: `submitForReview`
(draft→in_review), `withdraw` (in_review→draft), `publish` (in_review→published). `published` is
terminal and **immutable**.

**Revision identity differs by element kind** — the template-vs-clause asymmetry, made explicit rather
than forced into one model, via a discriminated `ElementRef`
(`clause | template | base | variant | include`):
- **Clause** — multi-version, per-locale. A published *row* is `(id, version, locale)`. `@latest` = the
  max version with ≥1 published locale row. Editing wording = a **new version** (a draft). Adding a
  translation to an existing version is an **additive new locale row** (allowed — it never rewrites an
  existing row, exactly like dropping a new `vN.<locale>.yaml`). Partial-locale states (en published,
  cs still draft) are legal.
- **Template / Base / Include / Variant** — a single logical element with a `version` field. Publish
  swaps the draft in as the newest published revision and bumps `version`; prior published revisions
  are retained as immutable history. There is no `@latest` ref syntax — `loadTemplate(id)` etc. return
  the newest published revision.

**Immutability granularity is the published row.** Once published, a row is never rewritten or deleted;
`updateDraft`/`deleteDraft` reject published content; edits always allocate a new version row. A clause
draft's version is allocated at `createDraft` (`maxKnownVersion + 1`, counting drafts, so concurrent
drafts don't collide); publish is the sole writer of a published row.

**The write interface EXTENDS the read seam — it does not mutate it.** A new
`EditableCatalogStore extends CatalogStore` adds `createDraft` / `updateDraft` / `deleteDraft` /
`listDrafts` / `loadDraft` / `submitForReview` / `withdraw` / `publish` / `auditLog`, over
`ElementContent` payloads that are the existing core domain types tagged by kind. `CatalogStore` itself
stays exactly ten read-only methods, so every existing consumer (`renderDocument`, `validate`, clause
diff) is unaffected, and the file store need not implement writes.

**The publish gate reuses `validate()`.** On `publish`, the facade first runs the existing
`validateCatalog` against a **draft-as-published overlay** (a thin wrapper store presenting the one
draft's rows as published over the real published set) via `Catalog.fromStore(overlay)`; findings block
the publish. No new validation logic — the integrity lint already checks clause `vars` across every
locale and surfaces variant `CompositionError`s.

**Audit is written by the store, atomically with each transition.** An `AuditEntry`
(`{ id, at, actor, action, element, revision?, from?, to?, note? }`) is persisted by the adapter as
part of the same operation as the state change, so it can never drift from the content state. This
**edit** audit complements the existing **content** audit (`ClausePin`/`Snapshot`, which freezes which
element versions went into a rendered document); the two are orthogonal and `ClausePin` is untouched.

**The concrete DB adapter and the editor UI live OUTSIDE the core package.** The core depends only on
the `EditableCatalogStore` interface. A SQLite adapter (`adapters/sqlite/`) and a
demo editor UI (`examples/demo/`) consume it. A guard keeps `src/**` from importing any DB driver, so
the published package stays product-agnostic and dependency-light.

> Implementation note: the SQLite adapter uses Node's **built-in `node:sqlite`** (`DatabaseSync`,
> synchronous) rather than the originally-planned `better-sqlite3` — the same SQLite engine with **no
> native/external dependency and no build step**. The synchronous API fits the workflow's sync-write
> seam, and the adapter is out-of-package so its experimental-API status never reaches consumers.

## Consequences

- `@latest` becomes publish-gated for DB-backed stores while file-based catalogs behave exactly as
  before. The semantic shift is contained to the one place latest is computed.
- `Catalog.fromStore` — until now an untested seam — becomes the primary entry point for editable
  catalogs and gains its first test coverage (read parity against `FileCatalogStore`).
- The facade grows an `editing` namespace (mirroring the memoized `get clauses`), present only when the
  store duck-types as editable. Non-editable (file) catalogs simply don't expose it.
- Two audit trails now exist and must not be conflated: **content** (what went into a document) and
  **edit** (who changed the catalog, when, and through which transition).
- A larger surface to keep coherent across adapters; mitigated by a **shared conformance suite** run
  against both the in-memory reference store and the sqlite adapter.

## Alternatives (revisit if this proves limiting)

- **Add write methods to `CatalogStore` directly.** Rejected — it would force `FileCatalogStore` and
  every reader to reckon with a write surface they don't need; extending via `EditableCatalogStore`
  keeps the read contract clean.
- **A stored `@latest` pointer instead of "max published version".** Rejected for now — computing
  latest from published rows needs no extra state and keeps `latestVersion` unchanged; a pointer could
  be layered later if editors need to pin latest to an older published version.
- **One unified revision model for all element kinds.** Rejected — clauses are genuinely
  versions-as-rows with `@latest`; templates/variants/includes are single-revision-with-history. Forcing
  one model onto both would distort the clause locale/version semantics.
- **A concrete DB (Postgres/Prisma) or a UI editor inside core.** Rejected — it would make the library
  product- and DB-specific. The adapter + UI stay outside; core ships only the interface.
- **Two-state (`draft → published`) workflow.** Rejected in favor of an explicit `in_review` step, per
  the plan's editorial review requirement; the transitions are small and the extra state is where the
  publish gate naturally runs.
