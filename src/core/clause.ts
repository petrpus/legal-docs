import type { VarsSchema } from "./vars-schema";

/**
 * A Clause: named, versioned, locale-aware reusable legal text. `text` is the markdown-subset source
 * (parsed into RichTextV1 at assembly); `vars` is its own mini-schema. There is no separate "Snippet"
 * type — a one-line phrase and a multi-page passage are both Clauses (ADR-0002).
 */
export interface Clause {
  /** Clause id. */
  clause: string;
  version: number;
  locale: string;
  vars: VarsSchema;
  text: string;
}
