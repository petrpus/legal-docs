import type { RichParagraph, RichTextV1 } from "./rich-text";
import { lcsAlign, pairAligned, type AlignStep } from "./text-diff";

/**
 * One structural change between two Clause versions, at the paragraph (block) level. The diff reports
 * only differences — identical paragraphs are omitted — so an unchanged Clause yields no changes.
 * Comparison is on paragraph plain text; mark-only changes (bold/italic) are not surfaced (a Phase 4
 * concern for the HTML renderer).
 */
export type ClauseDiffChange =
  | { op: "added"; text: string }
  | { op: "removed"; text: string }
  | { op: "replaced"; before: string; after: string };

/** A structured, human-reviewable diff of two Clause versions' rich text. */
export interface ClauseDiff {
  clause: string;
  from: number;
  to: number;
  locale: string;
  changes: ClauseDiffChange[];
}

/**
 * Diff two rich-text bodies into a minimal sequence of block changes: an LCS over paragraph plain text
 * ({@link lcsAlign}), with each changed run paired positionally into replacements ({@link pairAligned}).
 * Both live in `text-diff.ts` — the tree diff aligns node lists the same way.
 */
export function diffRichText(from: RichTextV1, to: RichTextV1): ClauseDiffChange[] {
  return coalesce(lcsAlign(from.blocks.map(plainText), to.blocks.map(plainText)));
}

function plainText(paragraph: RichParagraph): string {
  return paragraph.runs.map((run) => run.text).join("");
}

/** Drop unchanged blocks and pair adjacent removed+added blocks into `replaced` changes. */
function coalesce(steps: readonly AlignStep<string>[]): ClauseDiffChange[] {
  return pairAligned(steps).flatMap<ClauseDiffChange>((run) => {
    switch (run.op) {
      case "equal":
        return [];
      case "replaced":
        return [{ op: "replaced", before: run.before, after: run.after }];
      case "removed":
        return [{ op: "removed", text: run.before }];
      case "added":
        return [{ op: "added", text: run.after }];
    }
  });
}
