# Architecture

> Describes the as-built system (all roadmap phases delivered). Terminology follows
> [`CONTEXT.md`](./CONTEXT.md); rationale lives in [`adr/`](./adr/).

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
DocumentTree = { body: DocumentNode[]; header?; footer?; page? }  ◄── the renderer-agnostic seam
   │  applyEdits(tree, ops)   [optional]  ← post-generation editing: a human's Edit set, applied to
   │                                        the frozen tree of a Snapshot → an edited Snapshot
   ▼
DocumentTree (edited)                     ← same shape, so nothing downstream changes
   │  Renderer (visitor)                 ← PDF / HTML / DOCX, one per format
   ▼
result (discriminated by format)         ← pdf/docx: { buffer, stream }; html: { html };
                                            all carry { snapshot, snapshotId } for re-render
```

The **editing step is optional and off the generation path**: an ordinary render goes straight from
tree assembly to a Renderer. When it runs, it consumes a **Snapshot** rather than a payload — see
[Post-generation editing](#post-generation-editing) below.

`header`/`footer` are optional, resolved **Page furniture** (running page header/footer text plus
`$page.number`/`$page.total`, paged output only — ADR-0011), and `page` is the template's optional
**Page setup** (a size/orientation requirement overriding `theme.page` per-field — ADR-0013); a tree
with none of them is just the body. The tree renderers also accept a bare `DocumentNode[]` for a
caller not using furniture.

The three phases are deliberately separate so each is independently testable:

- **Validation** — payload conforms to the template's versioned schema.
- **Resolve phase** — declared **Derivation**s enrich the payload into the **Resolved payload**
  (`$derived.*`). All computed/structural inputs live here; templates only *read*. See ADR-0001.
- **Tree assembly** — evaluates the Template against the Resolved payload into a `DocumentNode[]`,
  performing **Binding** (value substitution) and **Reference resolution** (catalog lookups).

## The two seams

The architecture turns on two clean boundaries ("seams") where one side can be swapped without
touching the other:

1. **`DocumentTree` — between the engine and the renderers.** Core produces a neutral document tree
   (a `DocumentNode[]` body, plus optional page furniture and page setup); each **Renderer** is an exhaustive *visitor*
   over it. Author the structure once, render it to PDF, HTML, and DOCX. This is why layout must be
   abstracted away from react-pdf (today it is fused in).
2. **`CatalogStore` — between content storage and everything above it.** The **Catalog** loads
   authored content through this interface. **FileCatalogStore** (files + Git) is the read-only default;
   **`EditableCatalogStore`** extends it with a runtime editing API (drafting, a `draft → in_review →
   published` workflow, an audit log — ADR-0009), implemented by `MemoryEditableCatalogStore` and a
   `node:sqlite` adapter (`adapters/sqlite/`, outside the package). Both share one `EditingWorkflow`, so
   the core stays DB-free. `catalog.editing` surfaces it (a `validate()`-gated publish); `Catalog.fromStore`
   is the seam.

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
| `edit` | Post-generation editing — the Edit session (undo/redo, comments, preview) and tree normalization over `core/edit`'s ops, paths and redline model; browser-safe and editor-agnostic, published as the `@petrpus/legal-docs/edit` subpath | core, render-html |
| facade `@petrpus/legal-docs` | Unified public API (`renderDocument`, `Catalog`, `renderEdited`) | all |
| `cli` | `legal-docs` bin (`render`/`validate`/`schema`) — a thin wrapper over the facade + `Catalog`, no new capability | facade |

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
- **Edit set** — an ordered list of **Edit op**s, each addressing a node by **Tree path**, written
  against a **Base Snapshot** and frozen as an **Edited Snapshot**. The document edit audit; distinct
  from the catalog edit audit (ADR-0009), which changes the wording of *future* documents.

## Rendering

Each **Renderer** is an exhaustive visitor over the closed **Core node set**. Adding a core node kind
is a breaking change across all renderers (enforced by TS exhaustiveness), so it is done sparingly;
anything outside the set goes through a **Custom block**. When a node cannot be rendered in a target
format (chiefly a Custom block missing that format), the **Degradation contract** applies — default
`placeholder` (visible, logged marker), optionally `throw`; never silent omission.

Styling comes from a consumer-overridable **theme** (tokens for fonts, sizes, colours, geometry);
renderers read styles from the theme, never from hard-coded values. A partial theme (any subset of
tokens) is deep-merged over `defaultTheme` by `mergeTheme` — a consumer overrides one token without
re-spreading the rest. PDF and DOCX also render a Template's **Page furniture** (running header/footer,
page numbering) as part of tree assembly; the HTML fragment renderer has no page concept and ignores it.

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

## Post-generation editing

A generated document is frozen by its **Snapshot**, but legal work continues on the draft: a lawyer
rewords a sentence, strikes one, adds a paragraph the catalog does not have. That happens **over the
`DocumentTree`**, never over rendered output (ADR-0014), so one edit still renders to all three
formats and stays structurally diffable.

```
base Snapshot (full | tree)
   │  Edit session          ← createEditSession: op log + cursor (undo/redo), path-anchored comments,
   │                          preview / redline / review HTML, toEditSet()
   ▼
Edit set { baseSnapshotId, ops, comments? }   ◄── the artifact; plain JSON, this is what crosses the wire
   │  buildEditedSnapshot   ← applyEdits(tree, ops) + a deterministic id + derivedFrom
   ▼
edited Snapshot (tree mode, derivedFrom)      ── renderFromSnapshot / renderEdited → PDF · HTML · DOCX
   │  buildRedline(base, edited) → RedlineDoc  ← one model, three views:
   ▼                                             renderRedlineHtml · renderRedlineToDocx · diffTree
```

Four properties hold the design together:

- **Ops address a `TreePath`, not a node id.** A `DocumentNode` has no identity, so an `EditOp` names a
  position (`/body/2/heading`). `locate` is the single definition of the editable surface; `transformPath`
  rebases a path held across a structural op. An `EditError` names the op index, kind and path.
- **`applyEdits` is pure.** It validates the input tree, works on a deep copy and validates the result —
  a rejected op leaves the caller's tree untouched, so there are no partial edits.
- **The edited document is a Snapshot like any other.** `verifyEditedSnapshot(base, edited)` re-applies
  the ops to prove the audit record is intact; re-rendering goes through the unchanged
  `renderFromSnapshot`. `SNAPSHOT_SCHEMA_VERSION` is unchanged (2) — `derivedFrom` is additive.
- **Editing is a browser concern, export is not.** `@petrpus/legal-docs/edit` is a separate bundle
  (ADR-0012) carrying the session, the model and the HTML Renderer — no `node:` built-in, and no
  ProseMirror/TipTap/React: a WYSIWYG binds to the session from outside. Snapshot identity
  (`node:crypto`) and the PDF/DOCX exporters stay on the root entry.

The redline and review views are **additional Renderers over the same model**, never an export route:
`renderRedlineHtml` and `renderRedlineToDocx` (Word tracked changes + comments) render a `RedlineDoc`,
`renderReviewHtml` renders the document with its comments in the margin, and `diffTree` is the
`RedlineDoc` flattened to a path-addressed change list. A final PDF/DOCX/HTML goes through the ordinary
Renderers, so a comment can never leak into a deliverable. `normalizeTree` gives the canonical tree
form a WYSIWYG round-trips through.

Every boundary the artifact crosses is zod-validated: `editOpSchema`, `editSetSchema`, `commentSchema`,
`treePathSchema` and `editableNodeSchema` (the node union minus the opaque `custom` block), with
`assertValidEditSet` / `assertValidEditOp` throwing a path-precise `EditSetValidationError`.
`EDIT_SET_SCHEMA_VERSION` versions the artifact independently of the Snapshot, `EDIT_OP_KINDS` and
`documentNodeKinds()` expose the closed sets as data (a UI builds its op menu from them), `editOpPath`
reads an op's target, and `EditSessionError` reports a session used without a base id.

## Safety

Template expressions and Derivations run through a small, safe evaluator over the Helper registry —
no `eval`, no Turing-complete logic. A non-developer author cannot inject arbitrary code. The
integrity lint gates CI: every Block/Clause reference resolves, every helper is registered, and every
element's `vars` typecheck against the payload.

## Public API

```ts
import {
  Catalog, renderDocument, renderFromSnapshot, renderClauseDiff, exportPayloadSchema,
} from "@petrpus/legal-docs";

const catalog = await Catalog.fromDir("./legal-docs");        // FileCatalogStore, no DB

// Render to any format; the result is discriminated by `format` and carries a Snapshot.
const pdf  = await renderDocument({ catalog, template: "agreement", data, format: "pdf" });
const html = await renderDocument({ catalog, template: "agreement", data, locale: "cs", format: "html" });
const docx = await renderDocument({ catalog, template: "pledge-agreement", variant: "three-party",
                                    data, customBlocks, format: "docx" });

await renderFromSnapshot(pdf.snapshot, { format: "pdf" });    // deterministic re-render
catalog.validate({ customBlocks });                           // integrity lint
renderClauseDiff(await catalog.clauses.diff("aml.intro", { from: 2, to: 3 })); // HTML diff view
exportPayloadSchema(payloadSchema);                            // payload contract as JSON Schema
```

Post-generation editing splits over the two entries — the browser drives a session, the server freezes
and renders the result:

```ts
// browser (or anywhere): @petrpus/legal-docs/edit — no node: built-ins, no editor library
import { createEditSession, applyEdits, diffTree, buildRedline, normalizeTree,
         renderRedlineHtml, renderReviewHtml, type EditOp, type EditSet, type RedlineDoc,
         type TreePath } from "@petrpus/legal-docs/edit";

const session = createEditSession({ base: snapshot });         // a full|tree-mode base Snapshot
const path: TreePath = ["body", 2, "text"];
const op: EditOp = { kind: "setText", path, text: "Governing law: Czech law." };
session.apply(op);                                             // { ok: true } | { ok: false, error }
session.addComment({ path, text: "check with counsel", author: "jd" });
session.preview();                                             // HTML with data-path
session.redlineHtml();                                         // inline <ins>/<del> view
session.reviewHtml();                                          // the same, with margin comments
const edits: EditSet = session.toEditSet();                    // the artifact to send/store

// server: the root entry — identity and the exporters
import { buildEditedSnapshot, verifyEditedSnapshot, renderEdited,
         renderRedlineToDocx } from "@petrpus/legal-docs";

const edited = buildEditedSnapshot(snapshot, edits);           // tree-mode Snapshot + derivedFrom
verifyEditedSnapshot(snapshot, edited);                        // { ok } | { ok: false, issue }
const docx = await renderEdited({ snapshot, edits, format: "docx" }); // → { buffer, stream, snapshot }
const redline: RedlineDoc = buildRedline(snapshot.tree!, edited.tree); // diffTree(…) flattens it
await renderRedlineToDocx(redline, { author: "jd" });          // Word compare document
```

Everything above is also reachable from the root entry: `applyEdits`, `createEditSession`,
`normalizeTree`, `renderRedlineHtml` and `renderReviewHtml` are re-exported there, so a Node-only
consumer never needs the subpath.

Also available: a `legal-docs` **CLI** (`render`/`validate`/`schema`) over this same facade for
shell/CI use, and a composite **GitHub Action** wrapping `validate` as a PR check — see the root
[`README.md`](../README.md).

## See also

- [`CONTEXT.md`](./CONTEXT.md) — ubiquitous language.
- [`AUTHORING.md`](./AUTHORING.md) — how to write templates, clauses, variants, derivations.
- [`adr/`](./adr/README.md) — the decisions behind this architecture (indexed).
- [`PLAN.md`](./PLAN.md) — the approved source-of-truth design plan.
