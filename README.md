# @petrpus/legal-docs

> A universal, declarative library for generating **legal documents** — to **PDF**, **HTML preview**,
> and **DOCX** — from a typed payload and a **file-based catalog** of reusable building blocks.

**Status: 🌱 early development.** Phase 1 is underway: the core engine and a PDF renderer can turn a
declarative YAML template into a PDF through the renderer-agnostic document tree. The library is built
phase by phase per [`docs/PLAN.md`](docs/PLAN.md).

## Why

Most legal-document tooling fuses the *wording* into application code, so changing a clause means a
code change and a deploy, and non-developers can't touch the text. This library separates concerns:

- **Templates are data** (declarative YAML/JSON), readable and editable by non-developers.
- **Wording lives in a versioned catalog** of **blocks** (layout/structure) and **clauses** (reusable,
  versioned legal text, from a one-line phrase to a multi-page passage).
- **One renderer-agnostic document tree** is rendered to PDF, HTML, or DOCX.
- **Versioning + diffs** via files and Git; an **immutable snapshot** is frozen into every generated
  document for audit and deterministic re-render.

## Quickstart

```ts
import { Catalog, renderDocument } from "@petrpus/legal-docs";

const catalog = await Catalog.fromDir("./legal-docs");
const { buffer, snapshotId } = await renderDocument({
  catalog,
  template: "hello",
  data: {},
  format: "pdf",
});
```

## Core ideas

| Concept | What it is |
|---|---|
| **Block** | Catalog-registered layout / structural type (party header, signature field, key-value table, article, lists). |
| **Clause** | The single reusable text element: named, versioned, locale-aware legal text (rich text with `{{placeholders}}`), from a one-line phrase to a multi-page passage. |
| **Template** | A declarative tree composing blocks and clauses; supports variants, includes, and an escape hatch into a renderer-native component for special layouts. |
| **DocumentNode** | An instance node in the renderer-agnostic tree that each renderer (PDF/HTML/DOCX) visits. |
| **Payload** | A single typed object per document; validated, then enriched in a deterministic **resolve/derive** phase before rendering. |

See [`docs/CONTEXT.md`](docs/CONTEXT.md) for the full glossary, [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for the design, and [`docs/AUTHORING.md`](docs/AUTHORING.md) for how to write templates and clauses.

## Roadmap

See [`docs/PLAN.md`](docs/PLAN.md) for the full design and the phased roadmap (MVP + PDF parity →
file catalog + versioning + variants → special layouts → HTML diff → DOCX → public packaging).

## Development

This repo uses the [`claude-code-harness`](https://github.com/) workflow (issues → PRD → tracer-bullet
issues → TDD `implement-issue` with code-review and verify gates). The detailed bootstrap steps for
the first development session are in [`docs/PLAN.md`](docs/PLAN.md) and [`CLAUDE.md`](CLAUDE.md).

## License

[MIT](LICENSE) © Petr Puš
