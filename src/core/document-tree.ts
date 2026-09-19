/**
 * The renderer-agnostic document tree — the seam between a Template and the renderers.
 * A DocumentNode is an evaluated instance node; renderers visit it to emit PDF / HTML / DOCX.
 * The Core node set is closed (adding a kind is a breaking change across all renderers, enforced by
 * TS exhaustiveness); anything outside it goes through the `custom` escape hatch.
 */

import type { RichTextV1 } from "./rich-text";
import type { PageSetup } from "./page";

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

/** The assembled document body — the ordered node list a renderer visits. */
export type DocumentBody = DocumentNode[];

/**
 * The closed set of Core node kinds, as a runtime list. The {@link DocumentNode} union stays the
 * authority on each kind's *shape*; this array exists so a validator, a JSON Schema export or a UI
 * can enumerate the kinds without reflecting over types. {@link DocumentNodeKindsAreExhaustive} keeps
 * the two in lockstep at compile time.
 */
export const DOCUMENT_NODE_KINDS = [
  "title",
  "paragraph",
  "richText",
  "article",
  "numberedList",
  "bulletList",
  "alphaList",
  "partyHeader",
  "keyValueTable",
  "signatures",
  "custom",
] as const;

export type DocumentNodeKind = (typeof DOCUMENT_NODE_KINDS)[number];

/** `true` only when `A` and `B` are mutually assignable. Wrapped in {@link Assert} to fail the build. */
export type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Resolves to `T` when it is `true`, and is a type error otherwise — a compile-time assertion. */
export type Assert<T extends true> = T;

/**
 * Compile-time lockstep: adding a kind to {@link DocumentNode} without listing it in
 * {@link DOCUMENT_NODE_KINDS} (or the reverse) makes this alias a type error. Exported so it is part
 * of the module's checked surface rather than dead code.
 */
export type DocumentNodeKindsAreExhaustive = Assert<Mutual<DocumentNodeKind, DocumentNode["kind"]>>;

/** Runtime guard for {@link DocumentNodeKind} — the counterpart of `isAlign` for node kinds. */
export function isDocumentNodeKind(value: unknown): value is DocumentNodeKind {
  return typeof value === "string" && (DOCUMENT_NODE_KINDS as readonly string[]).includes(value);
}

/**
 * A resolved page header or footer (paged output only). Each slot is a fully-interpolated string; a
 * page-number token survives as a {@link PAGE_NUMBER_SENTINEL}/{@link PAGE_TOTAL_SENTINEL} marker that
 * a paged renderer substitutes per page (PDF/DOCX). HTML — a page-less fragment — ignores furniture.
 * The marker uses private-use codepoints so it never collides with authored content.
 */
export interface PageFurniture {
  left?: string;
  center?: string;
  right?: string;
}

/**
 * The renderer- and snapshot-facing document: the body plus optional resolved page furniture. Enriched
 * from a bare `DocumentNode[]` so headers/footers are frozen in the Snapshot and re-render deterministically.
 */
export interface DocumentTree {
  body: DocumentBody;
  header?: PageFurniture;
  footer?: PageFurniture;
  /** The template's page-geometry requirement, frozen for re-render; overrides `theme.page` per-field. */
  page?: PageSetup;
}

/**
 * Normalize a renderer input: a bare `DocumentNode[]` is treated as a document body with no furniture
 * (`{ body }`). This keeps the tree renderers back-compatible with a caller holding a plain node array.
 */
export function asDocumentTree(input: DocumentTree | DocumentBody): DocumentTree {
  return Array.isArray(input) ? { body: input } : input;
}

/**
 * Sentinels standing in for `$page.number` / `$page.total` in a resolved furniture slot. Assembly
 * interpolates furniture against the scope augmented with `$page = { number, total }` bound to these
 * markers; a paged renderer replaces them with the real per-page values it alone knows.
 */
const PAGE_TOKEN_MARK = "\uE000";
export const PAGE_NUMBER_SENTINEL = `${PAGE_TOKEN_MARK}page.number${PAGE_TOKEN_MARK}`;
export const PAGE_TOTAL_SENTINEL = `${PAGE_TOKEN_MARK}page.total${PAGE_TOKEN_MARK}`;
