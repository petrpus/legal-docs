# Legal Docs — Ubiquitous Language

The shared vocabulary of `@petrpus/legal-docs`: a universal, file-based library that turns a
typed data payload into a legal document (PDF / HTML / DOCX) from declarative templates and a
versioned catalog of reusable text elements.

This file is a **glossary, not a spec**. It records what each term *is*, not how it is implemented.

## Language

### Document tree

**DocumentNode**:
An instance node in the assembled, renderer-agnostic document tree — the seam between a template
and the renderers. Already evaluated and ready for a renderer (a *visitor*) to emit PDF/HTML/DOCX.
Has no `id` and no schema; it is pure output data, not a catalog entry.
_Avoid_: Block (that is the catalog type, not the tree instance), node, element.

### Catalog elements

The catalog has exactly **two** kinds of authored, reusable elements: **Block** (structure) and
**Clause** (text). Document-specific text that is neither reused nor independently versioned is **not**
a catalog element — it is written inline in the template and becomes a **DocumentNode** directly.

**Block**:
A catalog-registered *type* of structural / layout element that an author references in a template
(`partyHeader`, `keyValueTable`, `signatures`, `docTitle`). Has an `id`, a `kind` (which
DocumentNode it produces), and a zod `schema` for its props. Evaluated during tree assembly into
one or more **DocumentNode**s.
_Avoid_: component, widget, layout primitive (use "Block" for the catalog type).

**Clause**:
A named, versioned, locale-aware piece of reusable **legal text** held in the catalog, taking a typed
`vars` payload and referenced from one or more templates. Content is always **rich-text**
(`RichTextV1`) with `{{placeholder}}` tokens; a trivial one-line clause is just a single-paragraph
rich-text. Length is irrelevant — a one-sentence binding statement and a multi-page passage are both
Clauses. Editing a Clause produces a new version; every reference that resolves to it picks up the
change (see **Clause reference**).
_Avoid_: Snippet (resolved: there is no separate "Snippet" type — it is a Clause), text fragment,
boilerplate.

**Clause reference**:
How a template binds a **Clause**: either **pinned** (`clause@v2` — frozen wording) or **latest**
(`clause@latest` — automatically uses the newest published version, so an edit propagates to every
template that references it this way). Whichever is chosen, the document **Snapshot** freezes the
concrete version actually resolved, so audit and re-render stay deterministic.

**Custom block**:
A special kind of **Block** whose `kind` is `custom`: instead of a declarative definition it carries
a renderer-native implementation per output format (`CustomBlock<{ pdf; html?; docx? }>`). The
escape hatch for special-layout documents (e.g. a landscape grid promissory note). Registered in the
catalog like any other Block.

### Templates & composition

**Template**:
The renderable, versioned unit = one document type; what tree assembly turns into a
**DocumentNode** tree. A simple document is a standalone Template with no family or variant.

**Template family**:
An authoring-time group of related Templates sharing a **Base template**. Not renderable on its own —
you render one of its **Variant**s.

**Base template**:
The abstract member of a family that defines **Slot**s, iterates `for: $parties`, and gates sections
with `if:`. Not renderable directly.

**Variant**:
A named member of a family: `extends` a **Base template**, fills/overrides **Slot**s, and declares
its party roles. An **authoring** concept — it is resolved to a concrete **Template** *before* tree
assembly, so at runtime you always hold a Template, never a "Variant".

**Slot**:
A named override point declared in a **Base template** that a **Variant** fills or overrides.

**Include** (a.k.a. **Partial**):
A shared template fragment (e.g. a party-block set, a signature grid) referenced by several
Templates/Variants to keep repeated structure DRY.

> **Principle — reach for a Variant last.** Data-driven differences (party count, optional sections)
> are handled by a **single Template** via `for: $parties` + **Derivation**s. Wording differences
> ride on **Clause** versions (`security.3party@v2`). A named **Variant** (extends/slots) is reserved
> for genuine divergence in *authored structure* (~90% shared, a few sections differ) that inline
> conditionals would make messy.

### Rendering

**Renderer**:
A *visitor* over the **DocumentNode** tree that translates each node into one output format (PDF /
HTML / DOCX). The same tree feeds all renderers — author the structure once, render it many times.
Each Renderer is **exhaustive**: it must handle every node kind in the closed core set.

**Core node set**:
The fixed, versioned set of `DocumentNode` kinds (`title`, `paragraph`, `article`, `partyHeader`,
`keyValueTable`, lists, `signatures`, `richText`, …), chosen as the common denominator that all three
formats can represent. Adding a core kind is a breaking change across all Renderers (TS exhaustiveness
enforces it), so it is done sparingly. Anything outside the set goes through a **Custom block**.

**Degradation contract**:
What happens when a node cannot be fully rendered in a target format — chiefly a **Custom block**
missing that format's implementation (`CustomBlock<{ pdf; html?; docx? }>`, `pdf` required). Behaviour
is configurable (engine default, overridable), default **`placeholder`**:
- **`placeholder`** (default): insert a visible, logged marker (`[unsupported block: X in docx]`) and
  continue.
- **`throw`**: fail hard.
Silent omission is never allowed; degradation is always at least logged.

**InlineRich** / **RichTextV1**:
The shared, renderer-agnostic inline / rich-text model (ported from the reference app's
`legal-rich-text.ts`), living in core. Both **Clause** bodies and the `text` of text nodes use it.

### Catalog & persistence

**Catalog**:
The single top-level in-memory model of all **authored content** loaded from files — **Templates**,
**Blocks**, **Clauses**, and their versions. Public entry point (`Catalog.fromDir(...)`); exposes
`validate()` (integrity lint) and `clauses.diff(...)`.
_Avoid_: "registry" as a synonym for the authored content (see the qualified registries below).

**CatalogStore**:
The persistence seam abstracting *how* the **Catalog** loads, reference-resolves, and lists versions
of all authored content (Templates, Blocks, Clauses). The default and only current implementation is
**FileCatalogStore** (filesystem / bundle). A future DB-backed editing API is another adapter of the
same interface — not a rewrite. The store only loads/resolves/lists; **diff, integrity-lint and
`validate()` live in the Catalog layer above it**.

**FileCatalogStore**:
The file/bundle implementation of **CatalogStore** — the only store today. Versioning and diff come
from files + Git.

**Helper registry** / **Custom-block registry** / **Theme registry** / **Font registry**:
Code-side registrations, **not** part of the **Catalog**. The Helper registry whitelists pure
functions (`formatCurrency`, row-builders, Derivation functions); the Custom-block registry holds the
renderer-native implementations for `kind: custom`; Theme/Font registries hold consumer-overridable
styling assets. "Registry" is never used bare — always qualified.

### Snapshot & audit

**Snapshot**:
The immutable, serializable record a generation produces for audit and deterministic re-render. Its
contents depend on the **Snapshot mode**. The library *creates* it and returns it
(`{ buffer, snapshotId }`); **persisting and retrieving the Snapshot is the consumer's
responsibility**, like the rendered output. A Snapshot never freezes the rendered bytes — re-render
still depends on renderer stability (covered by renderer versioning + parity tests); a consumer who
needs a byte-exact archive stores the output artifact itself.

**Snapshot mode**:
Config (engine-level default, overridable per `renderDocument` call) choosing what a **Snapshot**
freezes. Default **`full`**.
- **`full`** (default): inputs (raw + Resolved payload, `template@v`/`variant`, all `clause@v` /
  `block@v` pins) **and** the assembled **DocumentNode** tree. Self-contained; re-render renders the
  frozen tree (immune to later catalog *and* engine changes); inputs give the audit trail.
- **`tree`**: the frozen **DocumentNode** tree only (+ minimal metadata). Self-contained re-render,
  lighter audit.
- **`pins`**: inputs + version pins only, **no tree**. Smallest, but re-render re-runs the engine
  over the pins — depends on engine stability *and* on the catalog still holding those versions.

### Resolution & derivation

The word "resolve" is reserved; three distinct operations get three distinct names.

**Resolve phase**:
The named, first-class, deterministic phase that runs all **Derivations** over the validated payload
and produces the **Resolved payload**. Runs after schema validation and before tree assembly.
_Avoid_: using "resolve" for path/var substitution (that is **Binding**) or for catalog lookups
(that is **Reference resolution**).

**Derivation**:
A declared, whitelisted **pure function** over the payload, computing a value onto the `$derived.*`
namespace (`counterpartsCount`, `hasAccessionDebtor`, `securityClause`). Unit-testable in isolation:
input payload → expected derived values, independent of rendering.

**Resolved payload**:
The validated payload enriched by the Resolve phase with the `$derived.*` values. What tree assembly
reads, and what the **Snapshot** freezes alongside the raw input.

**Binding**:
The tree-assembly step that substitutes `$paths`, `{{expr}}`, and Clause/Block `vars` from the
Resolved payload into the elements. Part of tree assembly, not the Resolve phase.
_Avoid_: "resolve paths".

**Reference resolution**:
The catalog looking up a **Block** or **Clause reference** to a concrete element/version (including
`@latest` → concrete version). Always the full phrase — never bare "resolve".

> **Principle — all computation is a Derivation.** Structural and derived inputs are computed *only*
> in the Resolve phase as Derivations; templates' `if`/`for` merely **read** the Resolved payload.
> Inline `if`/`for` may only *directly read* a payload or `$derived` field (incl. equality/boolean
> tests on scalars: `if: $borrowerType == "SOLE_TRADER"`). Anything computed — arithmetic, collection
> ops (`.length`, `.some`), multi-field logic, clause-version choice — **must** be a Derivation.

## Relationships

- An author references a **Block** or a **Clause** in a **Template**; the engine evaluates each into
  one or more **DocumentNode**s.
- A **Block** produces structural/layout **DocumentNode**s; a **Clause** produces text
  **DocumentNode**s (rich-text / paragraph).
- A **Clause reference** binds a **Clause** to a **Template** either pinned (`@vN`) or `@latest`.
- Inline literal text in a **Template** becomes a **DocumentNode** directly, with no catalog element.
- A **DocumentNode** is consumed by a renderer (PDF / HTML / DOCX) acting as a visitor.
- A **Custom block** is a **Block** with `kind: custom` and a per-format native implementation.
- The **Resolve phase** runs **Derivation**s over the payload → **Resolved payload**; tree assembly
  then **Binds** values and **Reference-resolves** Blocks/Clauses into **DocumentNode**s.
- A **Template family** groups **Variant**s over a shared **Base template**; a **Variant** resolves
  to a **Template** before tree assembly.
- A **Template** references **Block**s, **Clause**s, **Include**s and inline text in its body.
- The **Catalog** loads Templates/Blocks/Clauses through a **CatalogStore** (today
  **FileCatalogStore**); diff/lint/validate sit in the Catalog above the store.
- **Helper / Custom-block / Theme / Font registries** are code-side and live outside the Catalog.
- A generation produces a **Snapshot** (contents per **Snapshot mode**, default `full`); the consumer
  persists it and can hand it back for deterministic re-render.
- Each **Renderer** visits the **Core node set** exhaustively; a **Custom block** missing a format
  triggers the **Degradation contract** (default `placeholder`).
- **Clause** bodies and text-node `text` are **InlineRich** / **RichTextV1**.

## Example dialogue

> **Dev:** "Is `partyHeader` a DocumentNode?"
> **Domain expert:** "No — `partyHeader` is a **Block**: the catalog type the author writes in the
> template. When the engine runs, that Block produces a **DocumentNode** of kind `partyHeader` (or
> several nodes). The Block is the recipe; the DocumentNode is the dish."

## Flagged ambiguities

- "Block" vs "DocumentNode" — resolved: **Block** is the catalog type an author references;
  **DocumentNode** is the evaluated instance in the output tree. They are never the same object.
- "Snippet" vs "Clause" — resolved: **unified into a single Clause**. The plan's split was by length
  and content-model, neither of which is a real type boundary. Reusable versioned text =
  **Clause**; document-specific one-off text = inline → **DocumentNode**. See ADR-0002.
- "resolve" was overloaded (run derivations / substitute paths / look up references) — resolved:
  **Resolve phase** (derivations), **Binding** (path & var substitution), **Reference resolution**
  (catalog lookup). Three names, never bare "resolve" for the latter two.
- "template" named both a standalone Template and a Template family (the `renderDocument` param) —
  resolved: the `template` param accepts either; `variant` selects a family member. A **Variant** is
  authoring-only and resolves to a **Template**; only a Template is renderable.
- "registry" named both file-based authored content and code-side registration — resolved:
  authored content is the **Catalog**; code-side things are qualified registries
  (**Helper** / **Custom-block** / **Theme** / **Font**).
