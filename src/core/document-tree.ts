/**
 * The renderer-agnostic document tree — the seam between a Template and the renderers.
 * A DocumentNode is an evaluated instance node; renderers visit it to emit PDF / HTML / DOCX.
 * The Core node set grows one slice at a time; the walking skeleton covers `title` and `paragraph`.
 */

import type { RichTextV1 } from "./rich-text";

/** Inline text model. Minimal for now; structured rich text uses RichTextV1 (`richText` node). */
export type InlineRich = string;

export type DocumentNode =
  | { kind: "title"; text: InlineRich }
  | { kind: "paragraph"; text: InlineRich }
  | { kind: "richText"; value: RichTextV1 };

export type DocumentTree = DocumentNode[];
