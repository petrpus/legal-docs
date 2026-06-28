import type { ClauseDiff, ClauseDiffChange } from "../core/clause-diff";
import { defaultTheme, type Theme } from "../render-pdf/theme";
import { escapeHtml } from "./escape";

/**
 * Render a structured Clause diff (from `catalog.clauses.diff`, #23) into a human-readable, embeddable
 * HTML fragment — `<div class="clause-diff">` with a scoped `<style>`. The structured diff is
 * unchanged; this is purely its presentation. All text is escaped.
 */
export function renderClauseDiff(diff: ClauseDiff, theme: Theme = defaultTheme): string {
  const header = `<div class="clause-diff__header">${escapeHtml(diff.clause)}: v${diff.from} → v${diff.to}</div>`;
  const body =
    diff.changes.length === 0
      ? `<div class="clause-diff__empty">No changes between v${diff.from} and v${diff.to}.</div>`
      : diff.changes.map(changeHtml).join("");
  return `<div class="clause-diff"><style>${clauseDiffCss(theme)}</style>${header}${body}</div>`;
}

function changeHtml(change: ClauseDiffChange): string {
  switch (change.op) {
    case "added":
      return `<div class="diff-added"><ins>${escapeHtml(change.text)}</ins></div>`;
    case "removed":
      return `<div class="diff-removed"><del>${escapeHtml(change.text)}</del></div>`;
    case "replaced":
      return `<div class="diff-replaced"><del>${escapeHtml(change.before)}</del><ins>${escapeHtml(change.after)}</ins></div>`;
    default: {
      const unhandled: never = change;
      throw new Error(`Unsupported diff change: ${JSON.stringify(unhandled)}`);
    }
  }
}

function clauseDiffCss(t: Theme): string {
  // Every rule is scoped under `.clause-diff` (the renderer's scoping invariant). Padding/margin go on
  // the change rows only — not a `>div` catch-all that would override the header's margin.
  return [
    `.clause-diff{color:${t.color.text};font-family:serif;font-size:${t.fontSize.paragraph}px;}`,
    `.clause-diff .clause-diff__header{font-weight:bold;margin-bottom:${t.spacing.paragraph}px;}`,
    `.clause-diff .clause-diff__empty{font-style:italic;color:#666666;}`,
    `.clause-diff .diff-added{background:#e6ffed;padding:2px 4px;margin-bottom:2px;}`,
    `.clause-diff .diff-removed{background:#ffeef0;padding:2px 4px;margin-bottom:2px;}`,
    `.clause-diff .diff-replaced{padding:2px 4px;margin-bottom:2px;}`,
    `.clause-diff del{background:#ffeef0;text-decoration:line-through;}`,
    `.clause-diff ins{background:#e6ffed;text-decoration:none;}`,
  ].join("");
}
