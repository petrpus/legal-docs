# @petrpus/legal-docs

> A universal, declarative library for generating **legal documents** — to **PDF**, **HTML preview**,
> and **DOCX** — from a typed payload and a **file-based catalog** of reusable building blocks.

**Status: 🌱 bootstrapping.** This repository currently contains only the scaffold and the full
design plan. The library is built phase by phase per [`docs/PLAN.md`](docs/PLAN.md).

## Why

Most legal-document tooling fuses the *wording* into application code, so changing a clause means a
code change and a deploy, and non-developers can't touch the text. This library separates concerns:

- **Templates are data** (declarative YAML/JSON), readable and editable by non-developers.
- **Wording lives in a versioned catalog** of **blocks** (layout/structure), **snippets** (short
  repeated text with a payload), and **clauses** (longer versioned legal passages).
- **One renderer-agnostic document tree** is rendered to PDF, HTML, or DOCX.
- **Versioning + diffs** via files and Git; an **immutable snapshot** is frozen into every generated
  document for audit and deterministic re-render.

## Core ideas

| Concept | What it is |
|---|---|
| **Block** | Layout / structural primitive (party header, signature field, definition table, article, lists). |
| **Snippet** | Short, reusable text fragment with a typed payload (e.g. *"executed in {{count}} counterparts"*). |
| **Clause** | Longer, versioned legal passage (rich text with `{{placeholders}}`). |
| **Template** | A declarative tree composing blocks/snippets/clauses; supports variants, includes, and an escape hatch into a renderer-native component for special layouts. |
| **Payload** | A single typed object per document; validated, then enriched in a deterministic **resolve/derive** phase before rendering. |

## Roadmap

See [`docs/PLAN.md`](docs/PLAN.md) for the full design and the phased roadmap (MVP + PDF parity →
file catalog + versioning + variants → special layouts → HTML diff → DOCX → public packaging).

## Development

This repo uses the [`claude-code-harness`](https://github.com/) workflow (issues → PRD → tracer-bullet
issues → TDD `implement-issue` with code-review and verify gates). The detailed bootstrap steps for
the first development session are in [`docs/PLAN.md`](docs/PLAN.md) and [`CLAUDE.md`](CLAUDE.md).

## License

[MIT](LICENSE) © Petr Puš
