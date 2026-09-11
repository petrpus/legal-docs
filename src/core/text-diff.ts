/**
 * Sequence diffing — the shared algorithms behind the Clause diff, the tree diff and the redline.
 *
 * Deliberately knows nothing about the document model: everything here works on arrays of anything and
 * on plain strings. That is what lets the paragraph-level Clause diff (`clause-diff.ts`) and the
 * DocumentTree diff (`edit/redline-model.ts`) share one alignment, instead of each growing its own.
 *
 * Pure and dependency-free, so the whole editing layer stays browser-safe (ADR-0012).
 */

/** One step of an alignment: an element common to both sides, or present on only one. */
export type AlignStep<T> =
  | { op: "equal"; before: T; after: T; beforeIndex: number; afterIndex: number }
  | { op: "removed"; before: T; beforeIndex: number }
  | { op: "added"; after: T; afterIndex: number };

/**
 * Align two sequences on their longest common subsequence, reporting every element of both with the
 * index it holds on its own side. `same` decides what "common" means — reference/value equality by
 * default, structural equality for nodes, plain text for paragraphs.
 *
 * Ties are broken towards the removal, so a replaced element always reads as "removed then added".
 * O(n·m) time and memory: document-sized inputs, not log files.
 */
export function lcsAlign<T>(
  before: readonly T[],
  after: readonly T[],
  same: (a: T, b: T) => boolean = (a, b) => a === b,
): AlignStep<T>[] {
  const n = before.length;
  const m = after.length;
  // dp[i][j] = length of the longest common subsequence of before[i:] and after[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] ?? [];
    const next = dp[i + 1] ?? [];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = same(before[i] as T, after[j] as T) ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const steps: AlignStep<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const a = before[i] as T;
    const b = after[j] as T;
    if (same(a, b)) {
      steps.push({ op: "equal", before: a, after: b, beforeIndex: i, afterIndex: j });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      steps.push({ op: "removed", before: a, beforeIndex: i });
      i++;
    } else {
      steps.push({ op: "added", after: b, afterIndex: j });
      j++;
    }
  }
  for (; i < n; i++) steps.push({ op: "removed", before: before[i] as T, beforeIndex: i });
  for (; j < m; j++) steps.push({ op: "added", after: after[j] as T, afterIndex: j });
  return steps;
}

/** An alignment step after pairing: a replacement is a removal and an addition that stand for each other. */
export type AlignRun<T> =
  | Extract<AlignStep<T>, { op: "equal" | "removed" | "added" }>
  | { op: "replaced"; before: T; after: T; beforeIndex: number; afterIndex: number };

/**
 * Pair each maximal run of changed steps positionally: the k-th removal stands for the k-th addition.
 * The longer side's remainder stays a plain removal or addition, and pairs are emitted before it.
 *
 * Positional pairing is a heuristic — an alignment says *that* a run changed, never which old element
 * became which new one — but it is the one that makes "this paragraph was reworded" readable instead of
 * "this paragraph vanished and an unrelated one appeared".
 */
export function pairAligned<T>(steps: readonly AlignStep<T>[]): AlignRun<T>[] {
  const runs: AlignRun<T>[] = [];
  let removed: Extract<AlignStep<T>, { op: "removed" }>[] = [];
  let added: Extract<AlignStep<T>, { op: "added" }>[] = [];
  const flush = () => {
    for (const [k, remove] of removed.entries()) {
      const add = added[k];
      if (add === undefined) runs.push(remove);
      else {
        runs.push({
          op: "replaced",
          before: remove.before,
          after: add.after,
          beforeIndex: remove.beforeIndex,
          afterIndex: add.afterIndex,
        });
      }
    }
    for (const [k, add] of added.entries()) if (k >= removed.length) runs.push(add);
    removed = [];
    added = [];
  };
  for (const step of steps) {
    if (step.op === "equal") {
      flush();
      runs.push(step);
    } else if (step.op === "removed") removed.push(step);
    else added.push(step);
  }
  flush();
  return runs;
}

/** What a word-level segment says about the text it carries. */
export type InlineOp = "equal" | "ins" | "del";

/** A run of characters that is common to both texts, only in the new one, or only in the old one. */
export interface InlineSegment {
  op: InlineOp;
  text: string;
}

/** Words and whitespace runs are both tokens, so every character of both inputs is accounted for. */
const WORD_OR_SPACE = /\s+|\S+/gu;

/**
 * Diff two strings word by word into inline segments. Whitespace runs are tokens of their own, so the
 * segments reassemble exactly: `equal + del` is the old text and `equal + ins` is the new one, with no
 * normalisation. Within one changed run every deletion is emitted before every insertion, which is how
 * a redline reads (`<del>old</del><ins>new</ins>`).
 */
export function diffWords(before: string, after: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let deleted = "";
  let inserted = "";
  const push = (op: InlineOp, text: string) => {
    if (text.length === 0) return;
    const last = segments[segments.length - 1];
    if (last?.op === op) last.text += text;
    else segments.push({ op, text });
  };
  const flush = () => {
    push("del", deleted);
    push("ins", inserted);
    deleted = "";
    inserted = "";
  };
  for (const step of lcsAlign(tokenize(before), tokenize(after))) {
    if (step.op === "equal") {
      flush();
      push("equal", step.after);
    } else if (step.op === "removed") deleted += step.before;
    else inserted += step.after;
  }
  flush();
  return segments;
}

function tokenize(text: string): string[] {
  return text.match(WORD_OR_SPACE) ?? [];
}
