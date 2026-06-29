# @petrpus/legal-docs

> A universal, declarative library for generating **legal documents** — to **PDF**, **HTML**, and
> **DOCX** — from a typed payload and a **file-based catalog** of reusable, versioned building blocks.

One renderer-agnostic document tree, three renderers. Wording lives in versioned files (not code), so
a non-developer can edit a clause; every generated document freezes an immutable **Snapshot** for
audit and deterministic re-render.

## Why

Most legal-document tooling fuses the *wording* into application code, so changing a clause means a
code change and a deploy, and non-developers can't touch the text. This library separates concerns:

- **Templates are data** (declarative YAML), readable and editable by non-developers.
- **Wording lives in a versioned catalog** of **Clauses** (reusable, versioned, locale-aware legal
  text, from a one-line phrase to a multi-page passage).
- **One renderer-agnostic tree** (`DocumentNode[]`) is rendered to PDF, HTML, or DOCX by independent
  visitors.
- **Versioning + diffs** come from files + Git; an immutable **Snapshot** is returned with every
  generation for audit and deterministic re-render.

## Install

```sh
npm install @petrpus/legal-docs
```

Requires Node ≥ 20. The public API is ESM + TypeScript types.

## Quickstart

```ts
import { Catalog, renderDocument } from "@petrpus/legal-docs";

const catalog = await Catalog.fromDir("./legal-docs"); // your templates + clauses on disk
const data = { /* the typed payload your template expects */ };

// The result is discriminated by `format`:
const pdf = await renderDocument({ catalog, template: "agreement", data, format: "pdf" });
//    → { format: "pdf", buffer, stream, snapshot, snapshotId }
const html = await renderDocument({ catalog, template: "agreement", data, format: "html" });
//    → { format: "html", html, snapshot, snapshotId }
const docx = await renderDocument({ catalog, template: "agreement", data, format: "docx" });
//    → { format: "docx", buffer, stream, snapshot, snapshotId }
```

The consumer owns data fetching, persisting the output, and delivery. The library owns validation,
tree assembly, rendering, the file catalog, versioning, diff, and Snapshots.

## The authoring model

A **Catalog** is loaded from a directory of files:

```
legal-docs/
├── templates/
│   ├── agreement.yaml
│   └── pledge-agreement/          # a Template family
│       ├── base.yaml              # declares Slots, loops `for: $parties`
│       ├── two-party.yaml         # a Variant: extends base, fills Slots
│       └── three-party.yaml
├── partials/
│   └── party-block.yaml           # an Include (shared fragment)
└── clauses/
    └── welcome-note/
        ├── v1.en.yaml             # versioned, locale-tagged
        └── v1.cs.yaml
```

| Concept | What it is |
|---|---|
| **Template** | A declarative tree (YAML) composing Blocks, Clauses, Includes and inline text. The renderable unit. |
| **Block** | A catalog-registered structural type the author references (`partyHeader`, `keyValueTable`, `signatures`, `title`). |
| **Clause** | The single reusable text element: named, versioned, locale-aware rich text with `{{placeholder}}` tokens. Referenced pinned (`clause@v2`) or latest (`clause@latest`). |
| **Include** | A shared template fragment (a `partials/<id>.yaml`) spliced in via `{ include: <id> }`. |
| **Template family / Variant / Slot** | A `base` template declares named `slot`s and loops `for: $parties`; a **Variant** `extends` it and fills the Slots. Reach for a Variant last — data-driven differences stay in one Template. |
| **Custom block** | The escape hatch for special layouts: a code-side, renderer-native implementation (`custom: { component, props }`) — see below. |
| **Derivation** | A pure function over the payload computing `$derived.*` values, run in a deterministic Resolve phase before assembly. |

A template references Clauses and binds the payload via `$paths` and `{{ expr }}`; control flow is
`if:` / `for:`. The expression engine is small and safe — no `eval`, whitelisted helpers only. See
[`docs/AUTHORING.md`](docs/AUTHORING.md) for the full guide.

## Output formats & Custom blocks

All three renderers visit the same `DocumentNode[]` tree. For a layout the core node set can't express
(a multi-column signature grid, a landscape grid note), drop in a **Custom block** — a code-side
implementation per format, passed at render time:

```ts
import { renderDocument, type CustomBlock } from "@petrpus/legal-docs";

const signatureGrid: CustomBlock = {
  // schema: optional zod schema validating the block's props
  pdf: (props, { theme }) => /* a @react-pdf/renderer element */,
  html: (props, { theme }) => /* an HTML string (the block owns its markup) */,
  docx: (props, { theme }) => /* docx Paragraph/Table objects */,
};

await renderDocument({ catalog, template: "deed", data, customBlocks: { "signature-grid": signatureGrid }, format: "docx" });
```

A Custom block missing the target format degrades per the **Degradation contract**
(`degradation: "placeholder"` default — a visible, logged marker — or `"throw"`), never silently.
A worked example lives in [`examples/signature-grid.tsx`](examples/signature-grid.tsx).

## Snapshot & re-render

Every generation returns a serializable **Snapshot**. Persist it (the library doesn't), then re-render
later — deterministically, even after the catalog changes:

```ts
import { renderFromSnapshot } from "@petrpus/legal-docs";

const { snapshot } = await renderDocument({ catalog, template: "agreement", data, format: "pdf" });
// store `snapshot` (plain JSON) somewhere…
const again = await renderFromSnapshot(snapshot, { format: "pdf" }); // immune to later catalog edits
```

The Snapshot mode (`full` default / `tree` / `pins`) controls what is frozen; see
[`docs/adr/0003-snapshot-mode-configurable-default-full.md`](docs/adr/0003-snapshot-mode-configurable-default-full.md).

## Clause diff

Compare two Clause versions and render the diff for review:

```ts
import { renderClauseDiff } from "@petrpus/legal-docs";

const diff = await catalog.clauses.diff("aml.intro", { from: 2, to: 3 }); // structured data
const html = renderClauseDiff(diff);                                       // a reviewable HTML fragment
```

## Locale

Clauses are locale-aware (`clauses/<id>/v<N>.<locale>.yaml`). A Template has a default locale; override
it per render, with fallback for a partially-translated catalog:

```ts
await renderDocument({ catalog, template: "notice", locale: "cs", format: "html" }); // Czech clauses
```

## Theming

Every renderer reads a configurable **Theme**; pass `renderDocument({ theme })` to restyle. See
[`docs/THEMING.md`](docs/THEMING.md) for the token surface and how each renderer interprets units.

## Documentation

- [`docs/AUTHORING.md`](docs/AUTHORING.md) — write templates, clauses, variants, derivations, locale.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the renderer-agnostic tree, modules, data flow.
- [`docs/CONTEXT.md`](docs/CONTEXT.md) — the ubiquitous-language glossary.
- [`docs/THEMING.md`](docs/THEMING.md) — theme tokens and per-renderer units.
- [`docs/adr/`](docs/adr/) — Architecture Decision Records.
- [`CHANGELOG.md`](CHANGELOG.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md)

## License

[MIT](LICENSE) © Petr Puš
