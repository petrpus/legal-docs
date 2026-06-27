/**
 * A Template is the renderable, versioned unit (one document type), authored as declarative data.
 * The walking skeleton supports only inline `title` / `paragraph` body items; Blocks, Clauses,
 * control structures and payload binding arrive in later slices.
 */

export interface ArticleItem {
  no: string;
  heading?: string;
  body: BodyItem[];
}

/** Key-value rows: either authored literally (label/value, interpolatable) or built by a helper. */
export type KeyValueRows =
  | { label: string; value: string }[]
  | { fn: string; args?: unknown[] };

export type BodyItem =
  | { title: string }
  | { paragraph: string }
  | { clause: string; vars?: Record<string, unknown> }
  | { article: ArticleItem }
  | { numberedList: BodyItem[][] }
  | { bulletList: BodyItem[][] }
  | { alphaList: BodyItem[][] }
  | { partyHeader: { party: string; roleLabel: string } }
  | { keyValueTable: { rows: KeyValueRows } }
  | { signatures: { places: SignaturePlaceSpec[] } };

/** A signature slot: a `$`-path to a party (its name is used) or a literal/interpolated name. */
export interface SignaturePlaceSpec {
  party?: string;
  name?: string;
  role?: string;
}

export interface Template {
  /** Template id. */
  template: string;
  version: number;
  locale: string;
  /** Reference to the versioned payload schema this document validates against (optional). */
  payloadSchema?: string;
  body: BodyItem[];
}
