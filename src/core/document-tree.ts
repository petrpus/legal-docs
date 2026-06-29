/**
 * The renderer-agnostic document tree — the seam between a Template and the renderers.
 * A DocumentNode is an evaluated instance node; renderers visit it to emit PDF / HTML / DOCX.
 * The Core node set is closed (adding a kind is a breaking change across all renderers, enforced by
 * TS exhaustiveness); anything outside it goes through the `custom` escape hatch.
 */

import type { RichTextV1 } from "./rich-text";

/** Inline text model. Minimal for now; structured rich text uses RichTextV1 (`richText` node). */
export type InlineRich = string;

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
  | { kind: "title"; text: InlineRich }
  | { kind: "paragraph"; text: InlineRich }
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
