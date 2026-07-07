# Contributing

Thanks for your interest in `@petrpus/legal-docs`. This guide covers how to work in the repo.

## Setup

```sh
npm install
npm run verify   # typecheck + lint + tests + build — must be green
```

Requires Node ≥ 20 to consume the published library. Running `npm run verify` needs **Node ≥ 22.5**:
the `adapters/sqlite/` conformance test uses the built-in `node:sqlite` module, which isn't present on
Node 20 (the library itself stays Node ≥ 20 — that adapter is outside the published package).

## Workflow

Development is **issue-driven**: a PRD is broken into independently-grabbable tracer-bullet issues, each
implemented on its own branch as **one issue = one PR**.

1. Pick an issue. Read the linked PRD and the relevant [`docs/adr/`](docs/adr/) and
   [`docs/CONTEXT.md`](docs/CONTEXT.md) — the design and the ubiquitous language are the source of truth.
2. Branch from `main` (`feat/…`, `fix/…`, `docs/…`, `chore/…`).
3. Work test-first where it makes sense; keep changes within the issue's scope (a rabbit hole becomes a
   new issue, not a silent side-effect).
4. Run `npm run verify` — it must stay green.
5. Open a PR that closes the issue.

## Conventions

- **TypeScript, strict** (`noUncheckedIndexedAccess` on). No `any`, no `as Foo` casts.
- **Validation with zod**; the expression engine stays safe (no `eval`, whitelisted helpers only).
- **Comments explain WHY, not WHAT.** Match the surrounding code's style and idiom.
- **Tests assert external behaviour**, not implementation details; cover more than the happy path.
- **The public surface is product-agnostic** — nothing carries a specific product name. Concrete names
  belong only in tests / sample data.
- Each **Renderer** is an exhaustive visitor over the closed Core node set — adding a node kind is a
  breaking change across all three renderers (TS exhaustiveness enforces it). Special layouts go
  through a **Custom block**, not a new core node.

## Adding a design decision

A significant, hard-to-reverse decision with a real trade-off gets an **ADR** in
[`docs/adr/`](docs/adr/). New domain terms are sharpened in [`docs/CONTEXT.md`](docs/CONTEXT.md) (a
glossary — no implementation detail).

## Architecture orientation

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the renderer-agnostic tree and the two seams
(`DocumentTree` between engine and renderers; `CatalogStore` between content storage and everything
above). The full design and roadmap live in [`docs/PLAN.md`](docs/PLAN.md).

## HTML documentation site

`npm run docs:build` renders a subset of the repo's markdown docs (README, `docs/{ARCHITECTURE,
AUTHORING,CONTEXT,THEMING}.md`, `docs/recipes/*.md`, `CHANGELOG.md`, the demo/action READMEs) into a
static, self-contained HTML site under `docs/*.html` (source for GitHub Pages, `docs/` folder). It's
scoped to a project introduction and developer reference — the ADRs, `docs/PLAN.md` and
`CONTRIBUTING.md` stay repo-only (linked to on GitHub from any page that references them) rather than on
the public site. The generator is `scripts/build-docs-site.mjs` — **re-run it after editing any source
markdown**; it also rebuilds `docs/assets/browser-demo.js` (the browser-safe bundle from `src/browser.ts`
that powers `docs/live-demo.html`'s in-browser demo). The `.html`/`.js` files are committed (not
gitignored) so the site works without a build step once deployed.

Adding a new markdown doc to the repo does **not** automatically add it to the site — `assertManifestComplete()`
in the generator fails loudly if it finds an unregistered `.md` file outside the deliberately-excluded
set, so a new doc is either registered in `PAGES` (it becomes a site page) or added to `EXCLUDED`
(it stays repo-only).
