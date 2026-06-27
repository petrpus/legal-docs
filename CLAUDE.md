# CLAUDE.md — project guide for AI sessions

This repository is being built **autonomously** from a detailed, approved design plan. Everything in
this project is in **English**.

## Start here

1. **Read [`docs/PLAN.md`](docs/PLAN.md) in full.** It is the source of truth: architecture, domain
   model, authoring format, payload/resolve-derive phase, variants, versioning, renderers, roadmap,
   and verification strategy.
2. This is a **single package** (`@petrpus/legal-docs`) with internal modules under `src/`
   (`core`, `catalog`, `render-pdf`, `render-html`, `render-docx`) — split into a workspace later.
3. **No database now.** Templates and catalog elements are YAML/JSON files; versioning is via files +
   Git. A `CatalogStore` interface is the seam for a future DB-backed editing API.

## First-session bootstrap (the "minimal seed" handoff)

The repo currently has only: scaffold (`package.json`, `tsconfig`, `.gitignore`, `LICENSE`),
`README.md`, `docs/PLAN.md`, and the harness config (`.claude/settings.json`, `tmp/`). The **first
autonomous session should generate the rest** described in the plan's
*"Repository, documentation & autonomous-development setup"* section:

1. Run `/harness-doctor` to confirm harness setup; fix anything it flags.
2. Write the documentation skeleton: `docs/ARCHITECTURE.md`, `docs/AUTHORING.md`, `docs/CONTEXT.md`
   (ubiquitous domain language), and `docs/adr/0001-foundational-decisions.md` capturing the
   decisions already made in the plan.
3. Turn the plan into a **PRD** and then into **independently-grabbable issues** (tracer-bullet
   vertical slices), ordered by the roadmap phases (`/to-prd` → `/to-issues`).
4. Then run the loop: `/next` → `/implement-issue` (TDD red-green-refactor + code-reviewer agent +
   verify gate; one issue = one PR), repeating per the roadmap with parity/verify gates.

## Conventions

- TypeScript, strict. Validation with `zod`. Pure, whitelisted helpers only in templates — no
  arbitrary code in the authoring layer.
- Quality gates per the plan: golden/parity tests, schema tests, catalog-integrity lint,
  versioning/snapshot tests, multi-format smoke.
- Keep the public surface **product-agnostic** — nothing carries a specific product name.
