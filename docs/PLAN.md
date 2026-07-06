# Plan: `@petrpus/legal-docs` — a universal legal-document generation library

> **Historical document.** This is the original design plan; the whole roadmap (Phases 1–7, incl. the
> runtime editing API) is now **delivered**. Where this plan and the code disagree, the **as-built docs
> win** — see [`ARCHITECTURE.md`](ARCHITECTURE.md), [`AUTHORING.md`](AUTHORING.md),
> [`CONTEXT.md`](CONTEXT.md), the [ADRs](adr/), and [`../CHANGELOG.md`](../CHANGELOG.md). Kept for the
> rationale and the record of decisions (e.g. the superseded three-element model — see ADR-0002).

> This is a **design plan for a brand-new, standalone repository**. The current project
> (agenius-intranet) is only the **first consuming application / reference integration** and the
> source of prior art. **The only change to this repo is saving this plan** to
> `tmp/legal-docs-library-plan.md`. The library itself is built and versioned in a separate repo.

## Context

The reference application already has a working legal-document generator (≈10 document types:
credit agreement, pledge agreement, declarations, promissory note, repayment schedule, …) built on
`@react-pdf/renderer` and living under `app/pdf/`. It works, but it is structurally fused to one
application and one product, which blocks reuse and non-developer authoring. The recurring pains —
which generalize to **any** project that owns a body of important documents and needs to keep
editing and versioning them — are:

1. **Wording is hard-coded in code (TSX).** Legal text is embedded directly in components
   (e.g. constants and helper functions inside `app/pdf/templates/LOAN_24/debtor-declaration.tsx`).
   Any wording change means editing code, committing, deploying. A non-developer (lawyer / legal
   ops) cannot touch it. This is the **primary pain**.
2. **Monolithic registry + boilerplate.** A hand-written `switch` over every template key
   (`app/pdf/registry.ts`, `app/pdf/generator.ts`) — adding a document means editing several files.
3. **Hard application coupling.** Templates are bound to one product, to a DB-prefill layer, to
   config and object storage. Nothing is reusable on another project.
4. **No content versioning or audit.** No history, no diff, no record of "what exact text went into
   this generated document."

**Goal:** extract this into a **universal, multi-project (potentially public) library** with a
declarative, **file-based** authoring format editable by non-developers, **Git-backed versioning +
diffs**, and a consistent **data-in → document-out** API. Output to PDF + HTML preview + DOCX. A
runtime, DB-backed editing API is a **future** layer (the abstraction is designed now, files first).

### Confirmed decisions
- **Authoring model = hybrid (model B):** a template is a **declarative tree (data)** that
  references catalog elements; for the small minority of **special-layout documents** there is an
  **escape hatch** into a custom renderer-native component. Special layouts are a normal, expected
  category — not a one-off; the reference app's landscape promissory note is just one example.
- **Outputs:** PDF (react-pdf) + HTML preview + DOCX (all three).
- **Languages:** content starts in one locale, but the catalog and API are **locale-aware**
  (per-element locale + fallback) so adding languages later needs no refactor.
- **Three element kinds:** **Blocks** (layout / structural primitives), **Snippets** (short,
  repeated text with a payload), **Clauses** (longer versioned legal passages). Snippets and clauses
  both take a typed payload.
- **Everything is files, no DB (now).** Templates **and** catalog elements (clauses/snippets/blocks)
  live as **YAML/JSON files** in a template registry loaded from a folder/bundle. Versioning is via
  files + Git (history and diffs come for free). A pluggable `CatalogStore` interface is designed so
  a DB-backed runtime editing API can slot in **later** — but the default and only implementation now
  is file-based.
- **Document snapshot:** every generated document still freezes an immutable **snapshot** of the
  resolved content + element versions used, for audit and deterministic re-render.
- **Single typed root payload per document**, assembled by the consumer (no data fetching in the
  library); validated against the template's versioned zod schema (see *Payload*).
- **Variants are first-class:** template families compose via extends/slots + includes + payload
  conditionals so two/three-party variants never copy whole templates (see *Variants & composition*).
- **Author / package scope:** `@petrpus/*`. New repo, MIT-ready, public-capable.

---

## Target architecture

### Package layering (start single, split later)
**Start as one package** (`@petrpus/legal-docs`) with the layers below as **internal modules**
(`src/core`, `src/catalog`, `src/render-pdf`, …) and clean import boundaries between them. Once the
seams are proven, split into a pnpm/npm workspace of separate packages. The table is the eventual
target shape and the module layout to mirror from day one:

| Package | Responsibility | Depends on |
|---|---|---|
| `core` (module → later `@petrpus/legal-docs-core`) | Domain model (Block/Snippet/Clause/Template/DocumentNode), template engine (interpolation, conditionals, loops), payload validation (zod), rich-text model | zod |
| `catalog` (→ `…-catalog`) | Catalog of elements + versioning + diff + draft/publish + audit; pluggable persistence via a `CatalogStore` interface | core |
| `render-pdf` (→ `…-render-pdf`) | PDF renderer (react-pdf): blocks, theme, fonts, hyphenation | core, @react-pdf/renderer |
| `render-html` (→ `…-render-html`) | HTML renderer of the same tree (preview / diff / WYSIWYG) | core |
| `render-docx` (→ `…-render-docx`) | DOCX renderer (`docx` npm) | core |
| `react` (→ `…-react`) | Optional React components for an editor / live preview UI | render-html |
| facade `@petrpus/legal-docs` | Unified public API (`renderDocument`, `Catalog`) | all |

> **Core rendering principle:** core produces a **renderer-agnostic tree** (`DocumentNode[]`). Each
> renderer (PDF/HTML/DOCX) is a *visitor* over that single tree. This is the reason layout must be
> abstracted away from react-pdf (today layout is fused into react-pdf components).

### Domain model (core)

```ts
// Renderer-agnostic document tree (the seam between a template and the renderers)
type DocumentNode =
  | { kind: "title"; text: InlineRich }
  | { kind: "paragraph"; text: InlineRich; style?: StyleRef }
  | { kind: "article"; no: string; level: 1|2|3; body: DocumentNode[]; fullWidthBelow?: DocumentNode[] }
  | { kind: "partyHeader"; party: PartyIdentification; roleLabel: string }
  | { kind: "keyValueTable"; rows: KeyValueRow[] }
  | { kind: "numberedList" | "bulletList" | "alphaList"; items: DocumentNode[][] }
  | { kind: "signatures"; places: SignaturePlace[] }
  | { kind: "richText"; value: RichTextV1 }
  | { kind: "custom"; component: string; props: unknown }   // ← ESCAPE HATCH (special-layout docs)
  | ...

// Three element kinds
type Block   = { id; kind: DocumentNode["kind"]; schema: ZodType }     // layout / structure
type Snippet = { id; locale; version; template: string; schema: ZodType } // short repeated text + payload
type Clause  = { id; locale; version; richText: RichTextTemplate; schema: ZodType } // long versioned passage
```

- **Blocks** are structural/layout primitives (party header, signature field, definition table,
  article, lists). The reference app's `app/pdf/components/legal/*` are already nearly decoupled and
  become the PDF implementation of these blocks.
- **Snippets** are short reusable texts with variables ("This document is executed in {{count}}
  counterparts…"). Versioned, locale-aware.
- **Clauses** are longer versioned legal passages (today's hard-coded section/AML constants and bulk
  text). Stored as a rich-text template with placeholders; versioned via `clause@vN`.

### Template format (declarative tree, model B)

A template is data (YAML/JSON, optionally MDX-like), readable and editable by non-developers. It
references catalog elements and the payload. Illustrative (mirrors a declaration document):

```yaml
template: debtor-declaration
version: 3
locale: cs
payloadSchema: debtor-declaration       # reference to a versioned zod schema (see Typing)
body:
  - block: docTitle    text: "DECLARATION AND CONFIRMATION"
  - block: partyHeader  party: $borrower   roleLabel: "Borrower"
  - snippet: counterparty-intro
  - block: partyHeader  party: { from: $lender, as: company }   roleLabel: "Lender"
  - clause: declaration.intro@v2
  - article:
      no: "1."
      clause: loan.request@v2
      vars: { Loan: $loan }
      fullWidthBelow:
        - block: keyValueTable  rows: { fn: buildArticle1Rows, args: [$loan] }
  - for: { each: $warranties, as: w }                # loop
      article: { no: "2.{{index+1}}", body: [{ clause: $w }] }
  - if: $borrowerType == "SOLE_TRADER"               # conditional
      then:
        - article: { no: "3.", clause: sole.warranties.lead@v1 }
  - snippet: counterparts   vars: { count: 2 }
  - block: signatures   places: [$borrower]

  # Special-layout document: drop entirely into a renderer-native component
  # - custom: { component: "landscape-grid-note", props: $note }
```

- **Escape hatch:** special-layout documents (e.g. a landscape grid promissory note, a certificate
  with absolute positioning, a multi-column form) declare `custom: { component, props }`, where the
  component is a registered renderer-native implementation. The bulk of documents stay fully
  declarative; special layouts are an expected, supported category with a clear contract.

### Template expression syntax
- **Variables:** `$path.to.value`, `{{ expr }}` inside text.
- **Conditionals:** `if/then/else`, inline `{{ flag ? a : b }}`.
- **Loops:** `for: { each, as }`.
- **Helpers:** whitelisted pure functions (`formatCurrency`, `formatDate`, `clauseSet`, custom
  row-builders). No `eval`, no Turing-complete logic — a small safe expression evaluator
  (mini-parser or constrained `expr-eval`/`jsonata`). Authors cannot inject arbitrary code.
- **Rich-text placeholders:** clauses are rich text with `{{Token}}` placeholders resolved at render.
  Reuse the existing rich-text model (`app/utils/legal-rich-text.ts` is already app-independent →
  moves into core).

### Payload (how data flows in)
**One typed root payload object per document**, assembled by the consumer. The library never fetches
data — prefill/data-gathering stays in the consuming app.

```
consumer prefill → payload (typed) → validate(payloadSchema) → resolve $paths & element vars
                 → DocumentNode[] → renderer(s)
```

- Each template declares a **versioned zod `payloadSchema`** (ported from `app/pdf/registry.ts`).
  The engine validates the payload up front; consumers get the `z.infer` TS type for compile-time
  safety. Invalid payload fails fast with a path-precise error.
- The template binds payload into elements via **`$`-paths** and **`vars`**. Each clause/snippet
  declares its **own mini-schema for its `vars`**; the template maps a payload slice → element vars,
  and a **lint step** verifies every mapping is type-correct (caught at build, not deep at runtime).
- Payload is plain **JSON-serializable** data, so it is captured verbatim in the document **snapshot**
  → deterministic re-render and audit.
- Optional fields, defaults, and derived values come from **whitelisted pure helpers**
  (`formatCurrency`, `formatDate`, row-builders) — no logic lives in the template itself.
- **Shared building-block types** (party identification, money/loan slices, lender slice) are
  extracted into core as reusable zod fragments (today duplicated across schemas).

### Variants & composition (two/three-party contracts, etc.)
Variants that differ in a few blocks and clauses must **not** copy whole templates. Three composition
mechanisms, lightest first — combine as needed:

1. **Payload-driven conditionals** (`if` / `for`) — small differences (an extra party block, one
   clause swapped). The party set is part of the payload: `for: $parties`, `if: $parties.accessionDebtor`.
2. **Includes / partials** — shared fragments (a party-block set, a signature grid) referenced by
   many templates/variants. Keeps repeated structure DRY.
3. **Extends + named slots (template inheritance)** — a `base` template defines slots; a variant
   `extends` the base and fills/overrides specific slots. Ideal when the structure is ~90 % shared
   and only a few sections differ.

Expressed as a **template family** with variants:

```yaml
templateFamily: pledge-agreement
variants:
  two-party:   { extends: pledge-agreement.base, parties: [lender, pledgor] }
  three-party: { extends: pledge-agreement.base, parties: [lender, pledgor, accessionDebtor],
                 overrides: { "slot.security": { clause: security.3party@v2 } } }
```

The base iterates `for: $parties` and gates extras with `if:`; variants only declare their parties
and override the affected slots/clauses. Clause-level wording differences ride on **clause versions**
(`security.3party@v2`), not duplicated templates. Variant selection is explicit
(`renderDocument({ template: "pledge-agreement", variant: "three-party", ... })`).

### Payload resolution & derived values (payload-dependent structure)
Variant structure **and** element text routinely depend on payload values — e.g. a contract with 3,
4, or 5 parties: some wording changes, some sections are omitted, and a snippet like *"executed in
{{count}} counterparts"* needs a value derived from the data. This dependency logic is a **first-class,
deterministic, testable phase**, not ad-hoc `if`s scattered around.

**A `resolve` phase runs before tree assembly** and enriches the validated root payload into a
**resolved payload** (the chosen "enrich the base payload up front" option):

```
payload → validate(payloadSchema) → resolve(derivations) → resolvedPayload
        → tree assembly (conditionals/loops read resolvedPayload) → DocumentNode[] → render
```

- **Derivations** are declared per template (or template family) as **whitelisted pure functions**
  over the payload — e.g. `counterpartsCount = parties.length + 1`, `hasAccessionDebtor = parties.some(...)`,
  `securityClause = parties.length >= 3 ? "security.3party@v2" : "security.2party@v1"`. No arbitrary
  code; same safe evaluator/helper whitelist as the expression engine.
- Derived values land on a reserved namespace (e.g. `$derived.*`) so templates/snippets read them
  uniformly: `snippet: counterparts  vars: { count: $derived.counterpartsCount }`.
- Structural choices (omit a section, swap a clause version, repeat a party block N times) are driven
  by `resolvedPayload` through the existing `if`/`for` — so the **same mechanism** covers "text
  changes", "something is omitted", and "a snippet's payload changes".
- The **resolved payload is snapshotted** with the document → audit shows both the raw input and the
  derived values that shaped the output; re-render is deterministic.
- Derivations are unit-testable in isolation (input payload → expected derived values), independent of
  rendering — a key reason to make this an explicit phase.

### Versioning (file + Git, three levels)
1. **Catalog element:** each clause/snippet is versioned **by file** (e.g.
   `clauses/loan.request/v2.cs.yaml`, or a `version:` field). Templates reference a pinned version or
   `@latest`. History and diffs come from **Git**.
2. **Template:** `template@version` (file path / field) for structural changes.
3. **Document snapshot:** generating a document writes an **immutable snapshot** of all element
   versions used + the fully resolved content → audit of "exactly what was in this document."
   A snapshot can be re-rendered identically even after the catalog later changes.

### Catalog & registry (file-first; editing API is future)
**Now (files only):**
- Templates and catalog elements are **YAML/JSON files** under a registry folder, loaded into an
  in-memory catalog at startup (or bundled). No database.
- A **`CatalogStore` interface** abstracts loading/resolving elements; the default implementation is
  **`FileCatalogStore`** (filesystem/bundle). This interface is the seam a future DB store plugs into.
- **Diffs** today = file-to-file / Git diff, surfaced through the HTML renderer for human-readable
  clause comparison.
- **Integrity lint (CLI + test):** every `clause@vN` / `block` / `snippet` reference resolves; every
  payload helper is registered; every template's element `vars` typecheck against the payload. Gates CI.

**Future (not built now, but designed for):**
- A DB-backed `CatalogStore` + runtime **editing API** (CRUD, draft → review → publish, audit log)
  for non-developers to edit clauses live without a deploy. The on-disk schema and the
  versioning/diff model are designed so this is an additive adapter, not a rewrite.

### Styling / theming (extensible)
- **Theme tokens** (fonts, sizes, colors, article/table geometry) extracted from the reference
  app's style constants. The theme is **configurable/overridable** by the consumer via a definition
  file (`theme.ts`/`theme.json`). Renderers read styles from the theme, never from hard-coded values.
- Fonts are shipped as an asset bundle; consumers can register their own.

### Renderers (visitors over `DocumentNode[]`)
- **PDF:** port the reference `app/pdf/components/legal/*` as the PDF block implementations + the
  thin `renderToStream`/`renderToBuffer` wrapper. Hyphenation, fonts, paging retained.
- **HTML:** new renderer for preview/diff/WYSIWYG. Same blocks → HTML/CSS.
- **DOCX:** new renderer via the `docx` npm package. Map blocks to Word constructs (paragraphs,
  tables, styles).
- **Custom (escape-hatch) blocks** declare implementations per target format via a
  `CustomBlock<{ pdf; html?; docx? }>` contract. Where a format is unsupported, the degradation is
  **explicit and logged** (no silent omission).

---

## Prior art to port from the reference app

| Reference file(s) | Destination |
|---|---|
| `app/utils/legal-rich-text.ts` | `core` (rich-text model + normalization; already clean) |
| `app/pdf/components/legal/*` (Article, KeyValueBlock, SignatureBlock, PartyIdentificationBlock, lists, rich-text renderer, page, …) | `render-pdf` as PDF block implementations |
| `app/pdf/styles.ts`, `app/pdf/components/legal/legal-styles.ts` | `render-pdf` theme tokens (extract into config) |
| `app/pdf/fonts.ts`, `app/pdf/hyphenation.ts`, `app/pdf/assets/*` | `render-pdf` |
| `app/pdf/generator.ts` | `render-pdf` (thin wrapper) |
| `app/pdf/registry.ts` (`schemas`) | `core` payload schemas + shared fragments; the `switch` disappears (declarative registry) |
| Hard-coded wording in `templates/**/*.tsx` (section/AML constants, bulk-text files) | `catalog` as versioned clauses/snippets |
| Template structure in `templates/*.tsx` | declarative `.yaml/.json` templates; special-layout ones → custom blocks |
| `app/pdf/prefill/*`, `app/routes/api.pdf*`, auth, object storage, config | **stays in the consuming app** (integration layer) |

> Treat these as *prior art / source material*, not a literal lift. The library's public surface is
> product-agnostic; nothing carries a specific product name.

---

## Public API (proposed)

```ts
// Load the file-based registry once (templates + catalog elements from a folder/bundle)
import { Catalog, renderDocument } from "@petrpus/legal-docs";
const catalog = await Catalog.fromDir("./legal-docs");   // FileCatalogStore (no DB)

// Render
const pdf  = await renderDocument({ catalog, template: "debtor-declaration", version: 3, data, format: "pdf" });
const html = await renderDocument({ catalog, template: "debtor-declaration", data, format: "html" });
const docx = await renderDocument({ catalog, template: "pledge-agreement", variant: "three-party", data, format: "docx" });
//  → { stream, buffer, snapshotId }   (snapshot for audit / deterministic re-render)

// Validation / diff (file + Git based now)
catalog.validate();                                  // integrity lint: refs + payload-helper typecheck
catalog.clauses.diff("aml.intro", { from: 2, to: 3 }); // human-readable clause diff (via HTML renderer)

// FUTURE (DB-backed editing API; same CatalogStore seam):
// const cat = new Catalog({ store: dbStore });
// await cat.clauses.draft("aml.intro", {...}); await cat.clauses.publish("aml.intro");
```

The consumer owns: data fetching, transforming data into the typed payload (prefill), persisting the
output, delivery, and auth. The library owns: validation, tree assembly, rendering, the file-based
catalog/registry, versioning, diff, and snapshots.

---

## Reference integration (later, in the consuming app)
1. Add the package as a dependency; ship the `legal-docs/` registry folder (templates + catalog
   files) with the app.
2. **Keep the prefill layer** — it produces the typed payload and calls `renderDocument(...)` instead
   of react-pdf directly.
3. One-time seed of the file catalog by extracting today's hard-coded wording out of TSX into clause
   files.
4. *(Future)* If/when live non-developer editing is wanted, add a DB-backed `CatalogStore` adapter
   and wire the app's existing rich-text editor to the editing API — additive, no rewrite.

---

## Roadmap (phases)
1. **MVP core + PDF parity:** domain model, declarative engine, payload schemas, file registry +
   `FileCatalogStore`, PDF renderer from ported blocks. Target: 2–3 simpler documents rendered from
   YAML, byte/visually identical to today.
2. **File catalog + versioning + variants:** clauses/snippets as files, `@vN` versioning, snapshot,
   template families (extends/slots/includes), integrity lint. Move 2–3 documents' wording into files
   and prove a two/three-party variant.
3. **Escape hatch + special layouts:** custom-block contract; port the most complex documents
   (special-layout grid note, the largest agreement). Reach full document coverage.
4. **HTML renderer + diff (preview/WYSIWYG over files).**
5. **DOCX renderer.**
6. **Locale expansion, public-ready packaging** (docs, examples, theme-override API, license).
7. *(Future)* **DB-backed `CatalogStore` + runtime editing API** for live non-developer editing.

---

## Risks / open questions
- **PDF parity:** react-pdf is sensitive to layout (paging, `breakInside`, definition-table border
  merging). Risk of regression when moving from direct components to a tree — cover with snapshot
  tests.
- **Expression engine:** keep it small and safe; no Turing-complete logic in templates (otherwise a
  non-developer author becomes a security/maintenance risk). Whitelist helpers.
- **DOCX vs PDF parity:** Word's layout model differs; some blocks will degrade. Decide per block and
  log/document explicitly (no silent truncation).
- **Custom blocks across formats:** an escape-hatch component must declare an implementation per
  target format or the block is explicitly absent in that format — define the `CustomBlock` contract
  up front.
- **Wording migration:** the one-time extraction of hard-coded legal text into clauses is laborious
  and sensitive (it is legal text). Do it with diff verification against generated documents.

---

## Verification (how to validate the design during implementation)
1. **Golden / parity tests:** for each document, render with the old and new engines from the same
   payload and compare (text-layer extraction + visual snapshot via a PDF→PNG converter). Target:
   byte/visual parity for phases 1–3.
2. **Schema tests:** payload schemas reject invalid data (port the reference app's registry and
   route integration tests).
3. **Catalog integrity:** a lint test that every template resolves all references and payload helpers.
4. **Versioning/snapshot:** re-rendering from a snapshot yields identical output even after the
   catalog changes.
5. **Multi-format smoke:** the same tree → PDF + HTML + DOCX without error; documented degradations.
6. **Reference end-to-end (after integration):** the app's document endpoints return valid PDFs
   through the new library; verify via existing integration tests.

---

## Repository, documentation & autonomous-development setup

The new repo is built **autonomously** (Claude running in the repo, ideally on the always-on dev
server) using the **`claude-code-harness`** plugin. Everything in English. At handoff the repo gets
only a **minimal seed** (scaffold + plan + harness-init); the **first autonomous session generates
the rest below** (docs, ADR-0001, PRD → issue backlog) from `docs/PLAN.md`, then builds phase by
phase with quality gates. The following describes the repo's intended end state.

**Repo scaffold (single package, TS + zod):**
- `src/` with internal modules (`core`, `catalog`, `render-pdf`, `render-html`, `render-docx`),
  `legal-docs/` sample registry (templates + catalog files), `tests/`, `docs/`.
- Tooling: TypeScript, vitest (or node:test), eslint + prettier, tsup/build, GitHub Actions CI
  (typecheck + lint + test + parity), MIT license.
- `claude-code-harness` initialized (`/harness-init`): `.claude/settings.json`, `tmp/` for verify
  status, hooks; `harness-doctor` clean.

**Documentation (humans + AI):**
- **README.md** (rich, GitHub-facing): what/why, quickstart, the authoring model (blocks/snippets/
  clauses/templates), a worked example, output formats, links into `docs/`.
- `docs/ARCHITECTURE.md` — the renderer-agnostic tree, packages/modules, data flow.
- `docs/AUTHORING.md` — how non-developers write templates, snippets, clauses, variants, derivations.
- `docs/CONTEXT.md` — ubiquitous domain language (Block/Snippet/Clause/Template/DocumentNode/
  Variant/Derivation/Snapshot) maintained as the model evolves (harness `domain-modeling`).
- `docs/adr/` — Architecture Decision Records; **ADR-0001** captures the decisions already made here
  (hybrid model B + escape hatch; files-not-DB now; renderer-agnostic tree; resolve/derive phase;
  locale-aware; `@petrpus` scope). New ADRs per significant decision.
- `AGENTS.md` / `CLAUDE.md` — AI-facing guide: how to run tests/parity, conventions, where things live.
- `CONTRIBUTING.md`, `CHANGELOG.md`.

**Issue tracker + workflow (GitHub Issues):**
- Seed a **PRD** from this plan and break it into **independently-grabbable issues** (tracer-bullet
  vertical slices) using the harness flow (`to-prd` → `to-issues`), ordered by the roadmap phases.
- Each issue carries acceptance criteria + verification (parity/snapshot/lint) so it is closeable
  autonomously.
- Autonomous loop: the agent runs `next` → `implement-issue` (TDD red-green-refactor + code-reviewer
  agent + verify gate + open PR), one issue = one PR, repeat. Runs on the dev server continuously.

## Immediate next steps (on approval) — **minimal seed, then hand off**

Decided: **minimal seed** (the autonomous run generates docs/ADRs/issues itself), **private** GitHub
repo under the personal `petrpus` account.

1. Save this plan to `tmp/legal-docs-library-plan.md` in this repo (the only change to this repo).
2. **Create the new repo** at `~/Code/legal-docs`: `git init`; minimal single-package scaffold
   (`package.json` for `@petrpus/legal-docs`, `tsconfig`, `.gitignore`, MIT `LICENSE`, a short README
   stub); copy this plan in as `docs/PLAN.md`. Create the **private** GitHub repo via `gh`
   (`gh repo create petrpus/legal-docs --private --source . --push`). Initial commit + push.
3. Run **`/harness-init`** so the repo is harness-ready (`.claude/settings.json`, `tmp/`, hooks);
   sanity-check with `harness-doctor`. Commit.
4. **Hand off.** You start Claude in `~/Code/legal-docs` on the dev server. The first autonomous
   session reads `docs/PLAN.md` and produces the full scaffold the plan describes — README + docs
   (ARCHITECTURE/AUTHORING/CONTEXT) + ADR-0001 + PRD → issue backlog (phases 1–6) — then runs the
   `next` → `implement-issue` loop (TDD + code-reviewer + verify gate + one-PR-per-issue) per the
   roadmap with parity/verify gates.
