/**
 * The renderer-agnostic document tree — the seam between a Template and the renderers.
 * A DocumentNode is an evaluated instance node; renderers visit it to emit PDF / HTML / DOCX.
 * The Core node set grows one slice at a time; the walking skeleton covers `title` and `paragraph`.
 */

/** Inline / rich text model. Minimal for the walking skeleton; richens in a later slice. */
export type InlineRich = string;

export type DocumentNode =
  | { kind: "title"; text: InlineRich }
  | { kind: "paragraph"; text: InlineRich };

export type DocumentTree = DocumentNode[];
