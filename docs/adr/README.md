# Architecture decision records

Why this system is shaped the way it is. Each record states a decision, its consequences and the
alternatives that were rejected; the architecture itself is described in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) and its vocabulary in [`../CONTEXT.md`](../CONTEXT.md).

Records are append-only: a decision that no longer holds is superseded by a later record rather than
rewritten, so the reasoning of the day survives.

| #    | Decision                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 0001 | [Foundational decisions for `@petrpus/legal-docs`](./0001-foundational-decisions.md)                     |
| 0002 | [Unify Snippet and Clause into a single `Clause` element](./0002-unify-snippet-and-clause.md)            |
| 0003 | [Snapshot is configurable; default `full` freezes tree + inputs](./0003-snapshot-mode-configurable-default-full.md) |
| 0004 | [Payload schemas and registries are code-side, not Catalog content](./0004-payload-schemas-are-code-side.md) |
| 0005 | [The Custom block escape-hatch contract](./0005-custom-block-contract.md)                                |
| 0006 | [The HTML renderer: direct strings, fragment output, format-discriminated result](./0006-html-renderer-contract.md) |
| 0007 | [The DOCX renderer: docx-lib objects, a flat block model, point-based units](./0007-docx-renderer-contract.md) |
| 0008 | [Block-level styling: alignment & indentation as Theme defaults + per-block overrides](./0008-block-level-styling.md) |
| 0009 | [A runtime editing API: draft → in-review → published, over the same CatalogStore seam](./0009-editing-api-and-status.md) |
| 0010 | [Locale-aware helpers: opt-in `Intl`, deterministic by default](./0010-locale-aware-helpers.md)          |
| 0011 | [Page headers, footers & numbering (paged output)](./0011-page-headers-footers.md)                       |
| 0012 | [Browser-safe demo entry & public doc-site scope](./0012-browser-demo-and-public-site-scope.md)          |
| 0013 | [Page geometry: named formats, orientation & template-over-theme precedence](./0013-page-geometry.md)    |
| 0014 | [Post-generation editing: Edit sets over the tree, and the edited Snapshot](./0014-post-generation-editing-layer.md) |
