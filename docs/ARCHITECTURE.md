# Architecture

> Draft skeleton. Terminology follows [`CONTEXT.md`](./CONTEXT.md); rationale lives in
> [`adr/`](./adr/). Code examples are illustrative until Phase 1 fixes the concrete shapes.

`@petrpus/legal-docs` turns a typed data **payload** into a legal document (PDF / HTML / DOCX) from
declarative **Templates** and a versioned **Catalog** of reusable **Block**s and **Clause**s. It owns
validation, tree assembly, rendering, the file-based catalog, versioning, diff, and snapshots. It does
**not** fetch data, persist outputs, or carry any product name — the consumer owns those.

## Data flow

A single pipeline turns data into a document. Each arrow is a named, testable step.

```
consumer payload
   │  validate(payloadSchema)            ← zod, fails fast with a path-precise error
   ▼
validated payload
   │  Resolve phase                      ← runs Derivations (pure fns) → $derived.*
   ▼
Resolved payload
   │  tree assembly                      ← if/for read Resolved payload;
   │    ├─ Binding                          $paths / {{expr}} / vars substituted
   │    └─ Reference resolution             Block & Clause refs (@vN | @latest) looked up
   ▼
DocumentNode[]   ◄──────────────── the renderer-agnostic seam
   │  Renderer (visitor)                 ← PDF / HTML / DOCX, one per format
   ▼
{ stream, buffer, snapshotId }           ← plus a Snapshot for audit / deterministic re-render
```

The three phases are deliberately separate so each is independently testable:

- **Validation** — payload conforms to the template's versioned schema.
- **Resolve phase** — declared **Derivation**s enrich the payload into the **Resolved payload**
  (`$derived.*`). All computed/structural inputs live here; templates only *read*. See ADR-0001.
- **Tree assembly** — evaluates the Template against the Resolved payload into a `DocumentNode[]`,
  performing **Binding** (value substitution) and **Reference resolution** (catalog lookups).

## The two seams

The architecture turns on two clean boundaries ("seams") where one side can be swapped without
touching the other:

1. **`DocumentNode[]` — between the engine and the renderers.** Core produces a neutral document tree;
   each **Renderer** is an exhaustive *visitor* over it. Author the structure once, render it to PDF,
   HTML, and DOCX. This is why layout must be abstracted away from react-pdf (today it is fused in).
2. **`CatalogStore` — between content storage and everything above it.** The **Catalog** loads
   authored content through this interface. Today the only implementation is **FileCatalogStore**
   (files + Git); a future DB-backed editing API is another adapter, not a rewrite.

## Module layout

Start as **one package** (`@petrpus/legal-docs`) with internal modules and clean import boundaries;
split into a workspace once the seams are proven. The eventual package shape:

| Module (→ future package) | Responsibility | Depends on |
|---|---|---|
| `core` | Domain model (DocumentNode, Block, Clause, Template), template engine (Binding, conditionals, loops), Resolve phase, payload validation (zod), `InlineRich`/`RichTextV1` | zod |
| `catalog` | Catalog over `CatalogStore`; versioning, diff, integrity-lint, Snapshot | core |
| `render-pdf` | PDF visitor (react-pdf): blocks, theme, fonts, hyphenation | core, @react-pdf/renderer |
| `render-html` | HTML visitor (preview / diff / WYSIWYG) | core |
| `render-docx` | DOCX visitor (`docx` npm) | core |
| facade `@petrpus/legal-docs` | Unified public API (`renderDocument`, `Catalog`) | all |

## Domain model

The full glossary is [`CONTEXT.md`](./CONTEXT.md). In brief:

- **DocumentNode** — an instance node in the assembled tree (output-only).
- **Block** — a catalog-registered *type* of structural node an author references; evaluates into
  DocumentNode(s). A **Custom block** (`kind: custom`) is the escape hatch carrying a renderer-native
  implementation per format.
- **Clause** — a named, versioned, locale-aware piece of reusable legal text (always rich-text). The
  single text element (there is no separate "Snippet" — see ADR-0002).
- **Template** — the renderable, versioned unit. **Template family** / **Base template** / **Variant**
  / **Slot** / **Include** compose variants without copying. A Variant resolves to a Template before
  assembly.

## Rendering

Each **Renderer** is an exhaustive visitor over the closed **Core node set**. Adding a core node kind
is a breaking change across all renderers (enforced by TS exhaustiveness), so it is done sparingly;
anything outside the set goes through a **Custom block**. When a node cannot be rendered in a target
format (chiefly a Custom block missing that format), the **Degradation contract** applies — default
`placeholder` (visible, logged marker), optionally `throw`; never silent omission.

Styling comes from a consumer-overridable **theme** (tokens for fonts, sizes, colours, geometry);
renderers read styles from the theme, never from hard-coded values.

## Catalog, versioning & snapshots

The **Catalog** is the in-memory model of all authored content, loaded via a **CatalogStore**. It
exposes `validate()` (integrity lint) and `clauses.diff(...)`. Versioning has three levels:

1. **Catalog element** — each Clause/Block versioned by file; templates pin `@vN` or use `@latest`.
2. **Template** — `template@version` for structural changes.
3. **Snapshot** — every generation freezes a **Snapshot** (contents per **Snapshot mode**, default
   `full` = inputs + the assembled tree) for audit and deterministic re-render. See ADR-0003.

Three **code-side registries** sit outside the Catalog: the **Helper registry** (whitelisted pure
functions for expressions and Derivations), the **Custom-block registry** (renderer-native
implementations), and **Theme/Font registries**.

## Safety

Template expressions and Derivations run through a small, safe evaluator over the Helper registry —
no `eval`, no Turing-complete logic. A non-developer author cannot inject arbitrary code. The
integrity lint gates CI: every Block/Clause reference resolves, every helper is registered, and every
element's `vars` typecheck against the payload.

## Public API (proposed)

```ts
import { Catalog, renderDocument } from "@petrpus/legal-docs";

const catalog = await Catalog.fromDir("./legal-docs");        // FileCatalogStore, no DB
const pdf  = await renderDocument({ catalog, template: "debtor-declaration", data, format: "pdf" });
const docx = await renderDocument({ catalog, template: "pledge-agreement", variant: "three-party",
                                    data, format: "docx" });   // → { stream, buffer, snapshotId }

catalog.validate();                                            // integrity lint
catalog.clauses.diff("aml.intro", { from: 2, to: 3 });        // human-readable clause diff
```

## See also

- [`CONTEXT.md`](./CONTEXT.md) — ubiquitous language.
- [`AUTHORING.md`](./AUTHORING.md) — how to write templates, clauses, variants, derivations.
- [`adr/`](./adr/) — the decisions behind this architecture.
- [`PLAN.md`](./PLAN.md) — the approved source-of-truth design plan.
