/**
 * A Template is the renderable, versioned unit (one document type), authored as declarative data.
 * The walking skeleton supports only inline `title` / `paragraph` body items; Blocks, Clauses,
 * control structures and payload binding arrive in later slices.
 */

export type BodyItem =
  | { title: string }
  | { paragraph: string }
  | { clause: string; vars?: Record<string, unknown> };

export interface Template {
  /** Template id. */
  template: string;
  version: number;
  locale: string;
  /** Reference to the versioned payload schema this document validates against (optional). */
  payloadSchema?: string;
  body: BodyItem[];
}
