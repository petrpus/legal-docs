import type { RichParagraph, RichTextV1 } from "./rich-text";

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

/** Diff two rich-text bodies into a minimal sequence of block changes (LCS over paragraph text). */
export function diffRichText(from: RichTextV1, to: RichTextV1): ClauseDiffChange[] {
  return coalesce(lcsDiff(from.blocks.map(plainText), to.blocks.map(plainText)));
}

function plainText(paragraph: RichParagraph): string {
  return paragraph.runs.map((run) => run.text).join("");
}

interface RawOp {
  op: "unchanged" | "removed" | "added";
  text: string;
}

function lcsDiff(a: string[], b: string[]): RawOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] ?? [];
    const next = dp[i + 1] ?? [];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: RawOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i];
    const bj = b[j];
    if (ai === undefined || bj === undefined) break;
    if (ai === bj) {
      ops.push({ op: "unchanged", text: ai });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      ops.push({ op: "removed", text: ai });
      i++;
    } else {
      ops.push({ op: "added", text: bj });
      j++;
    }
  }
  for (; i < n; i++) {
    const ai = a[i];
    if (ai !== undefined) ops.push({ op: "removed", text: ai });
  }
  for (; j < m; j++) {
    const bj = b[j];
    if (bj !== undefined) ops.push({ op: "added", text: bj });
  }
  return ops;
}

/** Drop unchanged blocks and pair adjacent removed+added blocks into `replaced` changes. */
function coalesce(ops: RawOp[]): ClauseDiffChange[] {
  const out: ClauseDiffChange[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  // Pairing is positional by index within a changed run; a longer side's remainder is appended as
  // plain removed/added. Block-level text cannot recover sub-run ordering, so this is a heuristic.
  const flush = () => {
    for (const [k, before] of removed.entries()) {
      const after = added[k];
      if (after !== undefined) out.push({ op: "replaced", before, after });
      else out.push({ op: "removed", text: before });
    }
    for (const [k, after] of added.entries()) {
      if (k >= removed.length) out.push({ op: "added", text: after });
    }
    removed = [];
    added = [];
  };
  for (const op of ops) {
    if (op.op === "unchanged") flush();
    else if (op.op === "removed") removed.push(op.text);
    else added.push(op.text);
  }
  flush();
  return out;
}
