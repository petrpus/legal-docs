/**
 * A Template is the renderable, versioned unit (one document type), authored as declarative data.
 * The walking skeleton supports only inline `title` / `paragraph` body items; Blocks, Clauses,
 * control structures and payload binding arrive in later slices.
 */

export type BodyItem = { title: string } | { paragraph: string };

export interface Template {
  /** Template id. */
  template: string;
  version: number;
  locale: string;
  body: BodyItem[];
}
