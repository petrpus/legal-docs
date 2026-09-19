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
Has no `id` and no catalog identity; it is pure output data, not a catalog entry. It *does* have a
runtime schema (`documentNodeSchema`, `assertValidTree`) validating its shape. Because it carries no
id, everything that points *at* a node — an **Edit op**, a **Comment**, a `data-path` attribute in
rendered HTML — addresses it by its **Tree path**, its position in the tree.
_Avoid_: Block (that is the catalog type, not the tree instance), node, element.

**DocumentTree**:
The whole renderer- and Snapshot-facing seam: the ordered **DocumentNode** body plus optional
resolved **Page furniture** and the template's **Page setup** (`{ body, header?, footer?, page? }`).
A bare `DocumentNode[]` is still accepted by the tree renderers (normalized to `{ body }`) for a
caller not using furniture. See ADR-0011, ADR-0013.
_Avoid_: using "DocumentNode[]" as a synonym for the whole tree once furniture is in play — the tree
is the object, `body` is the node list.

**Page furniture**:
A resolved page header/footer for paged output (PDF/DOCX only — the HTML fragment renderer has no
pages and ignores it). Authored on a Template as `{ left?, center?, right? }` interpolated slots;
`{{ $page.number }}` / `{{ $page.total }}` are reserved tokens resolved **per page** by the renderer,
via sentinel markers frozen into the **Snapshot** alongside the rest of the furniture (so re-render is
deterministic). Presentation (size, colour, margin) is a Theme concern, not an authoring one. See
ADR-0011.
_Avoid_: "header"/"footer" unqualified when the running-page kind is meant (a Template's `title`
DocumentNode is unrelated).

**Page setup**:
A Template's declared page-geometry requirement (`page: { size?, orientation? }` — static enums, no
interpolation), carried verbatim onto the **DocumentTree** and frozen in the **Snapshot**. It
overrides `theme.page` **per-field** in the paged renderers (PDF/DOCX; the HTML fragment ignores it):
required geometry is content, not styling. The **effective page** — what a paged renderer actually
uses — is always computed by the single `effectivePage(theme, override)` helper. See ADR-0013.
_Avoid_: "page size" for the whole concept (orientation is part of it); putting geometry defaults
anywhere but `theme.page`.

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
The escape hatch for special-layout documents (e.g. a landscape grid promissory note). A **code-side**
renderer-native implementation per output format (`CustomBlock<{ pdf; html?; docx? }>`, `pdf` required),
held in the **Custom-block registry** — *not* the Catalog. A template references one by name through a
`custom` body item (`custom: { component, props }`); tree assembly binds the `props` and produces a
**DocumentNode** of kind `custom`, which the matching **Renderer** dispatches to the registered
implementation. A Custom block is a *leaf*: it renders its own complete layout, not core nodes. An
unregistered `component` is a hard error (and a lint finding); a missing *format* implementation
triggers the **Degradation contract**.

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

**Body item**:
One authored entry in a Template (or Include / Base template) body. Every Body item falls into
exactly one of four classes: a **leaf** (inline text, a **Clause reference**, a **Block** reference,
`custom`), a **nested** item that carries its own body (`article`, the lists), a **control** item
(`if` / `for`), or a **directive** (`include` / `slot`) — an authoring indirection spliced away
before tree assembly (by Include expansion / Slot filling), so it never becomes a **DocumentNode**.
The union is closed; anything that walks a body goes through **Body traversal**.

**Body traversal**:
The single module that owns the closed Body-item union — it classifies each item as leaf / nested /
control / directive and exposes generic walk/map over a Template body. Tree assembly, Include expansion, Slot
filling and the Catalog integrity lint are callbacks over it; they contribute only their own
behaviour, never the enumeration. TS exhaustiveness for Body items is enforced here, once.

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
Silent omission is never allowed; degradation is always at least logged. Because `pdf` is required,
PDF output never degrades — the contract governs the optional `html` / `docx` implementations.

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
of all authored content (Templates, Bases, Variants, Clauses, Includes). The read-only default is
**FileCatalogStore** (filesystem / bundle); **EditableCatalogStore** (see below) extends it with a
runtime editing API, implemented in-memory and over `node:sqlite` (`adapters/sqlite/`) — the seam the
design always anticipated. The store only loads/resolves/lists/writes; **diff, integrity-lint and
`validate()` live in the Catalog layer above it**.

**FileCatalogStore**:
The file/bundle implementation of **CatalogStore** — the read-only, Git-gated store. Versioning and
diff come from files + Git.

**EditableCatalogStore**:
The **write** seam (ADR-0009): a **CatalogStore** that *also* supports drafting, a status workflow, and
an edit audit — the adapter a runtime editing API (DB-backed) implements. It **extends** CatalogStore,
never mutates it. Invariant: the read methods surface **only Published** content, so drafts are
invisible to `@latest` and to every existing reader.

**Draft / In-review / Published**:
The three **statuses** of an editable revision. `Draft` → `In-review` (submit) → `Published` (publish);
`Published` is terminal and **immutable**. Editing wording = a new **Draft** version; a translation is
an additive locale row. _Avoid_: "unpublished" as a synonym — say `Draft` or `In-review`.

**Helper registry** / **Custom-block registry** / **Theme registry** / **Font registry**:
Code-side registrations, **not** part of the **Catalog**. The Helper registry whitelists pure
functions (`formatCurrency`, row-builders, Derivation functions); the Custom-block registry holds the
renderer-native implementations for `kind: custom`; Theme/Font registries hold consumer-overridable
styling assets. "Registry" is never used bare — always qualified.

### Snapshot & audit

**Content audit** vs **Edit audit**:
Three orthogonal trails, and the word "edit" is qualified in two of them. The **content audit** (the
**Snapshot**'s `ClausePin`s) freezes *which element versions went into a rendered document* — "what
was in this document". The **catalog edit audit** (`AuditEntry`, written by an
**EditableCatalogStore**, ADR-0009) records *who changed the catalog, when, and through which status
transition* — "who changed the wording, for every future document". The **document edit audit** (an
**Edit set** on an **Edited Snapshot**, ADR-0014) records *who changed this one assembled document
after generation* — it never touches the catalog, and the next document is unaffected. Never conflate
the three; say "catalog edit audit" or "Edit set", never a bare "edit audit".

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
- **`full`** (default): inputs (raw + Resolved payload, `template@v`/`variant`, all `clause@v` **ClausePin**s)
  **and** the assembled **DocumentNode** tree. Self-contained; re-render renders the frozen tree (immune
  to later catalog *and* engine changes); inputs give the audit trail. Carries a `schemaVersion`.
- **`tree`**: the frozen **DocumentNode** tree only (+ minimal metadata). Self-contained re-render,
  lighter audit.
- **`pins`**: inputs + version pins only, **no tree**. Smallest, but re-render re-runs the engine
  over the pins — depends on engine stability *and* on the catalog still holding those versions.

### Post-generation editing

A human changes an **assembled** document before export — a word, a struck sentence, an added
paragraph the catalog does not have. The catalog is untouched; the next document is unaffected. This
is a different activity from catalog editing (ADR-0009), and it borrows none of its vocabulary. See
ADR-0014.

**Tree path**:
Where an edit points. An array of keys and indices mirroring the **DocumentTree**'s own JSON shape
(`["body", 2, "heading"]`), written canonically as `/body/2/heading`. The addressing scheme for
everything that points at a node: an **Edit op**'s target, a **Comment**'s anchor, and the optional
`data-path` attribute the HTML Renderer emits. A path is only meaningful against one tree state, so a
path held across a structural edit must be *rebased* (`transformPath`) — and it may rebase to nothing
if the node it named was removed.
_Avoid_: "node id" (a **DocumentNode** has none), "selector", "pointer".

**Edit op**:
One typed change to a **DocumentTree** (`setText`, `setRichText`, `setStyle`, `replaceNode`,
`insertNode`, `removeNode`, `moveNode`, `insertListItem`, `removeListItem`, `setFurniture`). Ops apply
**in order**, each against the tree as the previous one left it. What an op may touch is defined once,
by `locate`: article numbering, a **Custom block**'s `props`, the **Page setup** and any node's `kind`
are not editable.
_Avoid_: "change", "patch", "command" for the single operation.

**Edit set**:
The artifact — an ordered list of **Edit op**s against one **Base Snapshot**, plus any **Comment**s
and the authorship metadata (`{ schemaVersion, baseSnapshotId, ops, comments?, author?, at?, note? }`).
Plain JSON, validated at every boundary, versioned independently of the **Snapshot**. It is the
*document edit audit*: the only route from a generated document to the edited one, so it travels on
the wire in place of an edited document.
_Avoid_: **revision** (reserved for catalog drafts, ADR-0009), "patch set", "changeset", "diff" (a
diff *describes* a change already made; an Edit set *is* the change).

**Edit session**:
The in-memory editing state an editor UI drives: the op log plus a cursor (undo/redo), the current
tree, the live **Comment**s, and `toEditSet()`. Framework-agnostic and browser-safe
(`createEditSession`, the `@petrpus/legal-docs/edit` subpath); a WYSIWYG shell binds to it from the
outside. An op that does not fit the tree is a typed result, not an exception.

**Base Snapshot**:
The **Snapshot** an **Edit set** is written against, identified by `baseSnapshotId`. Must carry a
frozen tree (`full` or `tree` mode — a `pins` snapshot cannot be a base), and is never mutated by
editing.

**Edited Snapshot**:
The result of applying an **Edit set** to its **Base Snapshot**: a first-class `tree`-mode
**Snapshot** with its own deterministic id, carrying `derivedFrom: EditSet` and inheriting the base's
template/version/variant/locale and provenance. It re-renders through the ordinary
`renderFromSnapshot`, and `verifyEditedSnapshot` re-applies the ops to prove the record is intact.
Editing an Edited Snapshot again chains. See ADR-0014, ADR-0003.
_Avoid_: "edited document" for the record (that is the output), "version 2 of the Snapshot".

**Redline**:
The renderer-agnostic description of what an **Edit set** did (`RedlineDoc`, from `buildRedline`): the
edited document mirrored block by block, deletions kept in place, changed strings carrying word-level
segments. One model, several views — the inline HTML redline, the Word **compare document** (tracked
changes), and `diffTree`, its flat path-addressed summary. Never an export route: a final PDF/DOCX/HTML
goes through the ordinary Renderers.
_Avoid_: "diff view" for the model (the model is the Redline; a view renders it), "track changes" for
anything but the DOCX projection.

**Comment**:
A note anchored to a **Tree path** in an edited document, with the quoted text captured at anchoring
time. Review-only: it rebases through structural ops, *orphans* when its node is removed (and returns
when that removal is undone), goes stale when the quoted text changes, and travels in the **Edit set**
— but no exporter renders it, so a comment can never leak into a PDF, DOCX or plain HTML.
_Avoid_: "annotation", "note" unqualified; a Word comment in the compare document is this term's
projection, not a separate concept.

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
> Inline `if`/`for` may only *directly read* a payload or `$derived` field, with comparisons
> (`== != < <= > >=`) and boolean combination of such reads (`&& || !`) — these only read
> (`if: $borrowerType == "SOLE_TRADER" && $hasGuarantor`). Anything *computed* — arithmetic,
> collection ops (`.length`, `.some`), value derivation from several fields, clause-version choice —
> **must** be a Derivation. (`for: each` must be a plain field path to an array.)

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
- A **Template** references **Block**s, **Clause**s, **Include**s and inline text in its body; each
  entry is a **Body item** (leaf / nested / control), and every walk over a body goes through
  **Body traversal**.
- The **Catalog** loads Templates/Blocks/Clauses through a **CatalogStore** (today
  **FileCatalogStore**); diff/lint/validate sit in the Catalog above the store.
- **Helper / Custom-block / Theme / Font registries** are code-side and live outside the Catalog.
- A generation produces a **Snapshot** (contents per **Snapshot mode**, default `full`); the consumer
  persists it and can hand it back for deterministic re-render.
- Each **Renderer** visits the **Core node set** exhaustively; a **Custom block** missing a format
  triggers the **Degradation contract** (default `placeholder`).
- **Clause** bodies and text-node `text` are **InlineRich** / **RichTextV1**.
- A **DocumentTree** is the **DocumentNode** body plus optional **Page furniture** and **Page
  setup**; only PDF/DOCX render them, and the **Snapshot** freezes both for deterministic re-render.
- An **Edit op** addresses a **DocumentNode** by **Tree path**; an ordered list of them against one
  **Base Snapshot** is an **Edit set**, which an **Edit session** produces and which
  `buildEditedSnapshot` turns into an **Edited Snapshot** — itself re-rendered by the same Renderers.
- Comparing a **Base Snapshot**'s tree with its **Edited Snapshot**'s yields a **Redline**, rendered
  inline as HTML or as a Word compare document; **Comment**s ride in the **Edit set** and are never
  rendered by an exporter.

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
- "edit" named both changing the catalog and changing one generated document — resolved: catalog
  editing produces a **Draft** revision through the `draft → in-review → published` workflow
  (ADR-0009) and changes every future document; document editing produces an **Edit set** applied to a
  **Base Snapshot** (ADR-0014) and changes exactly one. "Revision" belongs to the first, "Edit set" to
  the second, and an "edit audit" is always qualified as *catalog* or *document*.
- "registry" named both file-based authored content and code-side registration — resolved:
  authored content is the **Catalog**; code-side things are qualified registries
  (**Helper** / **Custom-block** / **Theme** / **Font**).
