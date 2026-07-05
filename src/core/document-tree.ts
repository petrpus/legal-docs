/**
 * The renderer-agnostic document tree — the seam between a Template and the renderers.
 * A DocumentNode is an evaluated instance node; renderers visit it to emit PDF / HTML / DOCX.
 * The Core node set is closed (adding a kind is a breaking change across all renderers, enforced by
 * TS exhaustiveness); anything outside it goes through the `custom` escape hatch.
 */

import type { RichTextV1 } from "./rich-text";

/** Inline text model. Minimal for now; structured rich text uses RichTextV1 (`richText` node). */
export type InlineRich = string;

/** Horizontal text alignment for block-level styling (ADR-0008). */
export const ALIGN_VALUES = ["left", "center", "right", "justify"] as const;
export type Align = (typeof ALIGN_VALUES)[number];

/** Runtime guard for the `Align` enum (authored YAML is cast, not zod-validated — see engine/lint). */
export function isAlign(value: unknown): value is Align {
  return typeof value === "string" && (ALIGN_VALUES as readonly string[]).includes(value);
}

/** Per-block indentation override (design points); an absent side inherits the Theme default (ADR-0008). */
export interface BlockIndent {
  /** First-line indent. */
  firstLine?: number;
  /** Left edge shift of the whole block. */
  left?: number;
}

export interface PartyIdentification {
  name: string;
  kind?: "person" | "company";
  idNumber?: string;
  address?: string;
}

export interface KeyValueRow {
  label: string;
  value: string;
}

export interface SignaturePlace {
  name: string;
  role?: string;
}

export type DocumentNode =
  // `align`/`indent` carry authored per-block overrides (ADR-0008); when absent the renderer applies
  // the Theme default (`theme.align.*`, `theme.indent.*`). `indent` is in design points.
  | { kind: "title"; text: InlineRich; align?: Align; indent?: BlockIndent }
  | { kind: "paragraph"; text: InlineRich; align?: Align; indent?: BlockIndent }
  | { kind: "richText"; value: RichTextV1 }
  | { kind: "article"; no: string; level: number; heading?: InlineRich; body: DocumentNode[] }
  | { kind: "numberedList"; items: DocumentNode[][] }
  | { kind: "bulletList"; items: DocumentNode[][] }
  | { kind: "alphaList"; items: DocumentNode[][] }
  | { kind: "partyHeader"; party: PartyIdentification; roleLabel: string }
  | { kind: "keyValueTable"; rows: KeyValueRow[] }
  | { kind: "signatures"; places: SignaturePlace[] }
  // Escape hatch (ADR-0005): a renderer-native Custom block, referenced by `component` name. `props`
  // is the bound, JSON-serializable payload the registered implementation receives.
  | { kind: "custom"; component: string; props: unknown };

export type DocumentTree = DocumentNode[];
