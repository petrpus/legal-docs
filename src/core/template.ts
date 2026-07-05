/**
 * A Template is the renderable, versioned unit (one document type), authored as declarative data.
 * Its `body` is a tree of `BodyItem`s — inline text, Blocks, Clauses, lists, control structures
 * (`if`/`for`), Includes, Slots and the `custom` escape hatch — bound against the payload at assembly.
 */

import type { Align } from "./document-tree";

export interface ArticleItem {
  no: string;
  heading?: string;
  body: BodyItem[];
}

/**
 * The object form of a `title`/`paragraph` body item, carrying per-block style overrides (ADR-0008).
 * `text` is interpolated (`{{ }}`); the style props are static. The bare string shorthand
 * (`- title: "…"`) stays the common case and is equivalent to `{ text: "…" }`.
 */
export interface TextSpec {
  text: string;
  align?: Align;
  /** Block left indent in design points (shifts the whole block). */
  indent?: number;
  /** First-line indent in design points. */
  firstLineIndent?: number;
}

/** Key-value rows: either authored literally (label/value, interpolatable) or built by a helper. */
export type KeyValueRows =
  | { label: string; value: string }[]
  | { fn: string; args?: unknown[] };

export type BodyItem =
  | { title: string | TextSpec }
  | { paragraph: string | TextSpec }
  | { clause: string; vars?: Record<string, unknown> }
  | { article: ArticleItem }
  | { numberedList: BodyItem[][] }
  | { bulletList: BodyItem[][] }
  | { alphaList: BodyItem[][] }
  | { partyHeader: { party: string; roleLabel: string } }
  | { keyValueTable: { rows: KeyValueRows } }
  | { signatures: { places: SignaturePlaceSpec[] } }
  | { if: string; then: BodyItem[]; else?: BodyItem[] }
  | { for: { each: string; as: string }; body: BodyItem[] }
  | { include: string }
  | { slot: string }
  | { custom: { component: string; props?: unknown } };

/**
 * An Include (a.k.a. Partial) is a shared, authored body fragment referenced by several Templates via
 * an `{ include: <id> }` body item. It is not renderable on its own; Include expansion splices its
 * body in place before tree assembly. (The type is named `Include` rather than `Partial` to avoid
 * shadowing the global `Partial<T>` utility type on the public surface.)
 */
export interface Include {
  /** Include id. */
  id: string;
  body: BodyItem[];
}

/** A signature slot: a `$`-path to a party (its name is used) or a literal/interpolated name. */
export interface SignaturePlaceSpec {
  party?: string;
  name?: string;
  role?: string;
}

export interface Template {
  /** Template id (the family id when this Template was composed from a Variant). */
  template: string;
  version: number;
  locale: string;
  /** Reference to the versioned payload schema this document validates against (optional). */
  payloadSchema?: string;
  /** Names of the Derivations the Resolve phase runs into `$derived.*` (optional). */
  derivations?: string[];
  body: BodyItem[];
  /** The Variant this Template was composed from (absent for a standalone Template). */
  variant?: string;
  /** Party roles declared by the Variant (absent for a standalone Template). */
  parties?: string[];
}

/**
 * The abstract member of a Template family: declares named `{ slot }` override points (and may use
 * `for: $parties` / `if:`), but is not renderable on its own — a Variant fills its Slots to produce a
 * concrete Template.
 */
export interface BaseTemplate {
  /** Family id. */
  base: string;
  version: number;
  locale: string;
  payloadSchema?: string;
  derivations?: string[];
  body: BodyItem[];
}

/**
 * A named member of a Template family: `extends` a Base template, declares its party roles, and fills
 * or replaces declared Slots. An authoring concept — it is composed into a concrete Template before
 * tree assembly.
 */
export interface Variant {
  /** Variant id. */
  variant: string;
  /** Family id this Variant extends (matches the Base template's `base`). */
  extends: string;
  /** Party roles this Variant declares (carried onto the composed Template). */
  parties?: string[];
  /** Slot fills, keyed by Slot name. Each key must name a Slot the Base declares. */
  overrides?: Record<string, BodyItem[]>;
}
