# Foundational decisions for `@petrpus/legal-docs`

This ADR records the decisions already made and approved in [`docs/PLAN.md`](../PLAN.md), so they are
captured as deliberate choices rather than implicit ones. Later ADRs refine or supersede individual
points (e.g. ADR-0002 on Clause, ADR-0003 on Snapshot mode).

## Decisions

1. **Hybrid authoring model ("model B") with an escape hatch.** A Template is a **declarative tree
   (data)** referencing catalog elements; the minority of special-layout documents drop into a
   renderer-native **Custom block**. Special layouts are an expected category, not a one-off.

2. **Renderer-agnostic document tree.** Core produces a neutral `DocumentNode[]` tree; each renderer
   (PDF/HTML/DOCX) is an exhaustive **visitor** over that one tree. Layout is abstracted away from
   react-pdf (today it is fused into react-pdf components). This is the central architectural seam.

3. **Files now, no database; `CatalogStore` is the seam for later.** Templates and catalog elements
   are YAML/JSON files loaded by a **FileCatalogStore**. Versioning is files + Git. A DB-backed
   editing API is a future adapter of the same `CatalogStore` interface, not a rewrite.

4. **Resolve phase is first-class.** A deterministic, unit-testable **Resolve phase** runs declared
   pure **Derivation**s over the validated payload, producing the **Resolved payload** (`$derived.*`)
   that tree assembly reads. All computed/structural inputs are Derivations; templates only read.

5. **Single typed root payload per document.** The consumer assembles one JSON-serializable payload;
   the library validates it against the template's versioned **zod** schema and never fetches data.

6. **Variants compose, never copy.** Differences are handled (lightest first) by payload conditionals
   + Derivations, then Includes/Partials, then extends + Slots. Wording differences ride on Clause
   versions. A named Variant resolves to a Template before assembly.

7. **Three outputs: PDF + HTML + DOCX.** PDF ports the reference app's `legal/*` blocks; HTML and
   DOCX are new visitors over the same tree.

8. **Locale-aware from day one.** Catalog elements and API carry per-element locale + fallback;
   content starts in one locale but adding languages later needs no refactor.

9. **Safe expression engine only.** Template expressions and Derivations use a small, safe evaluator
   over a whitelist of pure helpers — no `eval`, no Turing-complete logic. A non-developer author
   cannot inject arbitrary code.

10. **Single package now, split later; `@petrpus/*` scope, MIT-ready, product-agnostic.** Internal
    modules (`core`, `catalog`, `render-pdf`, `render-html`, `render-docx`) with clean boundaries,
    split into a workspace once the seams are proven. The public surface carries no product name.

## Why record these

They are architectural-shape and boundary decisions (renderer-agnostic tree, files-not-DB seam,
resolve phase, payload ownership) that a future reader would otherwise question, each chosen over a
real alternative (e.g. fused renderers, DB-first, logic-in-templates). The explicit no-s — no data
fetching in the library, no arbitrary code in authoring, no product coupling — are as load-bearing as
the yes-s.
