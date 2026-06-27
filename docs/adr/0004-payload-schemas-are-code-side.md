# Payload schemas and registries are code-side, not Catalog content

A Template references its payload schema by name (`payloadSchema: greeting@1`), but the schema itself
is a zod object — **code**, not authored file content. The same is true of the Helper registry and
(later) the Custom-block registry. The question is where these live relative to the **Catalog**.

**Decision:** payload schemas live in a code-side **`PayloadSchemaRegistry`** that the consumer passes
to `renderDocument({ schemas })`; they are **not** stored in or loaded by the Catalog. The Catalog
stays purely authored content (Templates, Blocks, Clauses) behind the `CatalogStore` seam. The engine
resolves a Template's `payloadSchema` reference against the registry supplied at render time, validates
the payload, and only then assembles the tree. Helpers follow the same pattern (`HelperRegistry`).

This keeps the file-based / future DB-backed `CatalogStore` concerned only with content that a
non-developer edits, while executable, type-bearing artifacts (zod schemas, helper functions) stay in
the consumer's code where they get compile-time checking and review.

## Consequences

- `renderDocument` takes `schemas` (and `helpers`) as inputs; a missing schema for a referenced
  `payloadSchema` is a fast, explicit error.
- Catalog integrity-lint (#8) will need access to the schema registry to typecheck `vars` mappings —
  it receives the registry, it does not own the schemas.
- Schema-version resolution is currently by exact string key (`greeting@1`); finer version handling
  can be added without moving schemas into the Catalog.
