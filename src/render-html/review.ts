/**
 * The review view: the document as it currently reads, with its comments as margin notes.
 *
 * It is the plain HTML Renderer's output — byte for byte, with `emitPaths` on — wrapped in a flex row
 * next to an `<aside>` of notes. Keeping the document render untouched is the point: a reviewer looks
 * at exactly what will be exported, and a UI can line a note up with its block by `data-path` (the
 * notes carry the same address). Nothing here can leak into an export, because no exporter goes
 * through this module — `renderReviewHtml` is a second, additional Renderer, never a mode of the first.
 */

import { asDocumentTree, type DocumentBody, type DocumentTree } from "../core/document-tree";
import { isCommentStale } from "../core/edit/comments";
import type { Comment } from "../core/edit/edit-set";
import { formatTreePath } from "../core/edit/tree-path";
import { mergeTheme, type Theme } from "../theme";
import { escapeHtml } from "./escape";
import { renderTreeToHtml, type RenderHtmlOptions } from "./render-html";

/** HTML render options plus what only the review view can answer. `emitPaths` is always on here. */
export interface RenderReviewOptions extends Omit<RenderHtmlOptions, "emitPaths"> {
  /** Heading above the notes column. Defaults to `"Comments"`. */
  notesTitle?: string;
  /** Show comments already marked resolved (default `true`). */
  includeResolved?: boolean;
}

/**
 * Render `tree` with `comments` shown as margin notes. Each note carries its comment id, its anchor
 * (absent once the comment was orphaned by a removal) and, when the quoted text has since changed, a
 * stale flag — see `isCommentStale`.
 */
export function renderReviewHtml(
  input: DocumentTree | DocumentBody,
  comments: readonly Comment[] = [],
  options: RenderReviewOptions = {},
): string {
  const tree = asDocumentTree(input);
  const theme = mergeTheme(options.theme);
  const document = renderTreeToHtml(tree, { ...options, emitPaths: true });
  const shown = options.includeResolved === false ? comments.filter((c) => c.resolved !== true) : comments;
  const title = options.notesTitle ?? "Comments";
  const notes =
    shown.length === 0
      ? `<div class="legal-review__empty">No comments.</div>`
      : `<ol class="legal-review__list">${shown.map((comment) => noteHtml(comment, tree)).join("")}</ol>`;
  return (
    `<div class="legal-review"><style>${reviewCss(theme)}</style>` +
    `<div class="legal-review__doc">${document}</div>` +
    `<aside class="legal-review__notes"><div class="legal-review__title">${escapeHtml(title)}</div>${notes}</aside>` +
    `</div>`
  );
}

function noteHtml(comment: Comment, tree: DocumentTree): string {
  const stale = isCommentStale(tree, comment);
  const classes = ["review-note"];
  if (comment.resolved === true) classes.push("review-note--resolved");
  if (comment.path === null) classes.push("review-note--orphaned");
  if (stale) classes.push("review-note--stale");
  // The anchor is an attribute, not text: an orphaned note simply has none.
  const anchor = comment.path === null ? "" : ` data-path="${escapeHtml(formatTreePath(comment.path))}"`;
  const meta = [comment.author, comment.at].filter((part): part is string => part !== undefined);
  const flags = [
    comment.resolved === true ? "resolved" : undefined,
    comment.path === null ? "orphaned" : undefined,
    stale ? "outdated quote" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  return (
    `<li class="${classes.join(" ")}" data-comment="${escapeHtml(comment.id)}"${anchor}>` +
    (meta.length === 0 ? "" : `<div class="review-note__meta">${escapeHtml(meta.join(" · "))}</div>`) +
    (comment.quote === undefined
      ? ""
      : `<blockquote class="review-note__quote">${escapeHtml(comment.quote)}</blockquote>`) +
    `<div class="review-note__text">${escapeHtml(comment.text)}</div>` +
    (flags.length === 0
      ? ""
      : `<div class="review-note__flags">${flags.map((flag) => `<span class="review-note__flag">${escapeHtml(flag)}</span>`).join("")}</div>`) +
    `</li>`
  );
}

function reviewCss(t: Theme): string {
  // Every rule is scoped under `.legal-review` (the Renderer's scoping invariant), and the layout is
  // CSS-only — a flex row, so the notes sit in the margin without any measuring pass. Printing a review
  // page drops the notes entirely: a comment is never part of the document.
  return [
    `.legal-review{display:flex;align-items:flex-start;gap:24px;color:${t.color.text};}`,
    `.legal-review .legal-review__doc{flex:1 1 auto;min-width:0;}`,
    `.legal-review .legal-review__notes{flex:0 0 220px;font-family:sans-serif;font-size:12px;line-height:1.4;}`,
    `.legal-review .legal-review__title{font-weight:bold;margin-bottom:8px;}`,
    `.legal-review .legal-review__empty{font-style:italic;color:#666666;}`,
    `.legal-review .legal-review__list{list-style:none;margin:0;padding:0;}`,
    `.legal-review .review-note{border-left:3px solid #f0b429;background:#fffbea;padding:6px 8px;margin-bottom:8px;}`,
    `.legal-review .review-note--resolved{border-left-color:#a0aec0;background:#f7fafc;opacity:0.6;}`,
    `.legal-review .review-note--orphaned{border-left-color:#e53e3e;background:#fff5f5;}`,
    `.legal-review .review-note--stale{border-left-style:dashed;}`,
    `.legal-review .review-note__meta{color:#888888;font-size:11px;margin-bottom:2px;}`,
    `.legal-review .review-note__quote{margin:0 0 4px;padding:0;font-style:italic;color:#666666;}`,
    `.legal-review .review-note__text{white-space:pre-wrap;}`,
    `.legal-review .review-note__flags{margin-top:4px;}`,
    `.legal-review .review-note__flag{display:inline-block;margin-right:4px;padding:0 4px;border-radius:2px;background:#00000014;font-size:10px;text-transform:uppercase;}`,
    `@media print{.legal-review .legal-review__notes{display:none;}}`,
  ].join("");
}
