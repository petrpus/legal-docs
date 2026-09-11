/**
 * The compare document: the edited document as a Word file with native tracked changes and comments.
 *
 * It is a visitor over the one {@link RedlineDoc} the model builds (`core/edit/redline-model.ts`) —
 * the same structure the inline HTML redline walks — installed on the *plain* DOCX Renderer through
 * its {@link DocxTrack} hook. Nothing here re-implements a node kind: the Renderer lays the document
 * out exactly as it always does and asks this module what a piece of text is, which is why a compare
 * document with no changes is byte for byte the document itself.
 *
 * What Word gets: `w:ins`/`w:del` runs (with author and date) for changed words and for whole
 * inserted/deleted blocks, a tracked paragraph mark on those blocks so accepting or rejecting leaves
 * no empty paragraph behind, and `w:comment` entries anchored by comment range + reference.
 *
 * Two things a compare document cannot express, both a consequence of ADR-0005 (a `custom` block is
 * opaque code, so its runs are not ours to mark) and of ADR-0011 (page furniture is not body text):
 * a `custom` block that was added or removed is reported by a tracked marker paragraph, and changed
 * header/footer slots are reported as a trailing section, exactly as the HTML redline does.
 *
 * Like the inline redline, this is a second, additional Renderer — never a mode of the first. No
 * exporter routes through it, so a compare document cannot leak into a delivered DOCX.
 */

import {
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  DeletedTextRun,
  Document,
  InsertedTextRun,
  Packer,
  Paragraph,
  Table,
  TextRun,
} from "docx";
import type { ICommentOptions, IParagraphRunOptions, ParagraphChild } from "docx";
import type { DocumentNode } from "../core/document-tree";
import type { Comment } from "../core/edit/edit-set";
import type {
  RedlineBlock,
  RedlineDoc,
  RedlineField,
  RedlineListItem,
  RedlineParagraph,
  RedlineRun,
} from "../core/edit/redline-model";
import { formatTreePath, type TreePath } from "../core/edit/tree-path";
import { LegalDocsError } from "../core/errors";
import type { InlineSegment } from "../core/text-diff";
import type { RenderTreeOptions } from "../custom-block";
import type { Theme } from "../theme";
// The layout vocabulary is shared with the HTML redline — one `mode` union, two Renderers.
import type { RedlineMode } from "../render-html/redline";
import {
  articleHeadingDocx,
  createDocxRenderContext,
  docxDocumentOptions,
  docxListLead,
  docxRichRun,
  renderListItemToDocx,
  renderNodeToDocx,
  type DocxRenderContext,
  type DocxRunStyle,
  type DocxTextPart,
  type DocxTrack,
  type DocxTrackedParagraph,
} from "./render-docx";
import { halfPoints, twips } from "./theme-docx";

/** Render options plus what only a compare document can answer. */
export interface RenderRedlineDocxOptions extends RenderTreeOptions {
  /** Layout. Defaults to `"inline"`, the only mode implemented. */
  mode?: RedlineMode;
  /** The author Word attributes every tracked change to. Defaults to `"legal-docs"`. */
  author?: string;
  /** The date on every tracked change, as Word wants it (ISO-8601). Defaults to now. */
  date?: string;
  /** Comments to carry into Word's review pane, anchored by their `path` in the edited tree. */
  comments?: readonly Comment[];
}

/**
 * Render a {@link RedlineDoc} as a .docx with Word's own Track Changes and comments. The result is the
 * *edited* document — its page setup, header and footer are the edited ones — with every difference
 * from the base marked up so a reviewer can accept or reject it in Word.
 */
export async function renderRedlineToDocx(redline: RedlineDoc, options: RenderRedlineDocxOptions = {}): Promise<Buffer> {
  const mode = options.mode ?? "inline";
  if (mode !== "inline") {
    throw new LegalDocsError(`unsupported redline mode "${String(mode)}" — only "inline" is implemented (side-by-side is reserved)`);
  }
  const ctx = createDocxRenderContext(options);
  const state = createRedlineState(options, ctx.theme);
  const body = redline.blocks.flatMap((block) => blockDocx(block, ctx, state));
  const children = [...body, ...furnitureDocx(redline.furniture, ctx.theme, state)];
  const anchored = state.anchoredComments();
  const doc = new Document({
    ...docxDocumentOptions(redline.edited, ctx, children),
    ...(anchored.length > 0 ? { comments: { children: anchored } } : {}),
  });
  return Packer.toBuffer(doc);
}

/* ------------------------------------------------------------------ verdicts */

/** What happened to the text a context is about to emit. */
type Verdict = "unchanged" | "inserted" | "deleted";

/* ------------------------------------------------------------------ state */

/** The mutable bookkeeping one render needs: revision ids, and which comment has found its anchor. */
interface RedlineState {
  theme: Theme;
  /** A fresh `{ id, author, date }` for one tracked change. */
  change(): { id: number; author: string; date: string };
  /** Whether any not-yet-anchored comment overlaps `path`. Pure. */
  anchored(path: TreePath): boolean;
  /** Claim every not-yet-anchored comment overlapping `path`, returning their Word ids. */
  claim(path: TreePath): number[];
  /** The comments that found an anchor, in the order Word will number them. */
  anchoredComments(): ICommentOptions[];
}

function createRedlineState(options: RenderRedlineDocxOptions, theme: Theme): RedlineState {
  const author = options.author ?? "legal-docs";
  const date = options.date ?? new Date().toISOString();
  const pending = [...(options.comments ?? [])].filter((comment) => comment.path !== null);
  const claimed = new Map<number, Comment>();
  // Word numbers revisions and comments in two separate id spaces, so they get two counters — and a
  // comment's id stays predictable (0, 1, 2 … in document order) however many changes surround it.
  let nextChangeId = 0;
  let nextCommentId = 0;
  const overlaps = (comment: Comment, path: TreePath): boolean => {
    const anchor = comment.path;
    if (anchor === null) return false;
    const shorter = anchor.length <= path.length ? anchor : path;
    const longer = anchor.length <= path.length ? path : anchor;
    return shorter.every((step, index) => step === longer[index]);
  };
  return {
    theme,
    change: () => ({ id: nextChangeId++, author, date }),
    anchored: (path) => pending.some((comment) => overlaps(comment, path)),
    claim(path) {
      const taken = pending.filter((comment) => overlaps(comment, path));
      const ids: number[] = [];
      for (const comment of taken) {
        pending.splice(pending.indexOf(comment), 1);
        const id = nextCommentId++;
        claimed.set(id, comment);
        ids.push(id);
      }
      return ids;
    },
    anchoredComments: () =>
      [...claimed.entries()]
        .sort(([a], [b]) => a - b)
        .map(([id, comment]) => {
          const at = commentDate(comment, date);
          return {
            id,
            children: [new Paragraph({ children: [new TextRun({ text: comment.text, size: halfPoints(theme.fontSize.paragraph) })] })],
            ...(comment.author !== undefined ? { author: comment.author, initials: initialsOf(comment.author) } : {}),
            ...(at !== undefined ? { date: at } : {}),
            ...(comment.resolved === true ? { resolved: true } : {}),
          };
        }),
  };
}

/** Word shows initials next to a comment; derive them rather than asking the caller for a second name. */
function initialsOf(author: string): string {
  const letters = author
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("").slice(0, 3);
}

function commentDate(comment: Comment, fallback: string): Date | undefined {
  const parsed = new Date(comment.at ?? fallback);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/* ------------------------------------------------------------------ the track */

/** A context whose text emission is taken over by the redline, for one block's verdict and fields. */
function trackedCtx(ctx: DocxRenderContext, state: RedlineState, verdict: Verdict, fields: readonly RedlineField[]): DocxRenderContext {
  const mark = paragraphMark(verdict, state);
  return {
    ...ctx,
    track: createTrack(state, verdict, fields),
    ...(mark ? { paragraphMark: mark } : {}),
  };
}

/**
 * A tracked paragraph mark for a wholly inserted or deleted block. Without it, accepting an insertion
 * (or rejecting a deletion) in Word leaves the empty paragraph behind.
 */
function paragraphMark(verdict: Verdict, state: RedlineState): IParagraphRunOptions | undefined {
  if (verdict === "unchanged") return undefined;
  return verdict === "inserted" ? { insertion: state.change() } : { deletion: state.change() };
}

function createTrack(state: RedlineState, verdict: Verdict, fields: readonly RedlineField[]): DocxTrack {
  const index = new Map(fields.map((field) => [formatTreePath(field.path), field]));
  // A deleted block's paths address the BASE tree, so nothing in it may claim a comment: the same
  // positional path either resolves to nothing or to a different node in the document being edited.
  const claimable = verdict !== "deleted";
  const fieldAt = (path: TreePath | undefined): RedlineField | undefined => (path === undefined ? undefined : index.get(formatTreePath(path)));

  return {
    has: (path) => index.has(formatTreePath(path)),
    text(parts, style) {
      const anchorsAhead = claimable && parts.some((part) => part.path !== undefined && state.anchored(part.path));
      const changed = parts.some((part) => fieldAt(part.path) !== undefined);
      // Nothing to say beyond the block's own verdict: one run, exactly as the plain Renderer emits.
      if (!anchorsAhead && !changed) return [verdictRun(parts.map((part) => part.text).join(""), style, verdict, state)];
      return parts.flatMap((part) => anchor(partRuns(part, style, verdict, state, fieldAt(part.path)), part.path, claimable, state));
    },
    richText(node, path) {
      const field = fieldAt([...path, "value"]);
      const paragraphs: DocxTrackedParagraph[] =
        field?.kind === "richText"
          ? field.paragraphs.map((paragraph) => diffedParagraph(paragraph, state))
          : node.value.blocks.map((block) => ({
              children: block.runs.map((r) => verdictRichRun({ ...r, op: "equal" }, state.theme.fontSize.paragraph, verdict, state)),
            }));
      const ids = claimable ? state.claim(path) : [];
      const first = paragraphs[0];
      if (ids.length > 0 && first) first.children = wrapInComment(first.children, ids);
      return paragraphs;
    },
  };
}

/** The children one text part contributes: its word-level diff when it changed, else one run. */
function partRuns(part: DocxTextPart, style: DocxRunStyle, verdict: Verdict, state: RedlineState, field: RedlineField | undefined): ParagraphChild[] {
  if (field?.kind === "text") return field.segments.flatMap((segment) => segmentRuns(segment, style, state));
  if (part.text.length === 0) return [];
  return [verdictRun(part.text, style, verdict, state)];
}

function segmentRuns(segment: InlineSegment, style: DocxRunStyle, state: RedlineState): ParagraphChild[] {
  if (segment.text.length === 0) return [];
  const as: Verdict = segment.op === "ins" ? "inserted" : segment.op === "del" ? "deleted" : "unchanged";
  return [verdictRun(segment.text, style, as, state)];
}

function anchor(children: ParagraphChild[], path: TreePath | undefined, claimable: boolean, state: RedlineState): ParagraphChild[] {
  if (!claimable || path === undefined) return children;
  const ids = state.claim(path);
  return ids.length === 0 ? children : wrapInComment(children, ids);
}

/** A Word comment anchor: a range around the text, plus the reference mark that carries the balloon. */
function wrapInComment(children: readonly ParagraphChild[], ids: readonly number[]): ParagraphChild[] {
  return [
    ...ids.map((id) => new CommentRangeStart(id)),
    ...children,
    ...ids.flatMap((id) => [new CommentRangeEnd(id), new CommentReference(id)]),
  ];
}

function runOptions(style: DocxRunStyle) {
  return {
    size: halfPoints(style.size),
    ...(style.bold !== undefined ? { bold: style.bold } : {}),
    ...(style.italics !== undefined ? { italics: style.italics } : {}),
    ...(style.color !== undefined ? { color: style.color } : {}),
  };
}

function verdictRun(text: string, style: DocxRunStyle, verdict: Verdict, state: RedlineState): ParagraphChild {
  if (verdict === "unchanged") return new TextRun({ text, ...runOptions(style) });
  const change = state.change();
  return verdict === "inserted"
    ? new InsertedTextRun({ ...change, text, ...runOptions(style) })
    : new DeletedTextRun({ ...change, text, ...runOptions(style) });
}

function verdictRichRun(run: RedlineRun, sizePt: number, verdict: Verdict, state: RedlineState): ParagraphChild {
  const as: Verdict = verdict !== "unchanged" ? verdict : run.op === "ins" ? "inserted" : run.op === "del" ? "deleted" : "unchanged";
  if (as === "unchanged") return docxRichRun(run, sizePt);
  const change = state.change();
  const options = { ...change, text: run.text, size: halfPoints(sizePt), bold: run.marks?.includes("bold") ?? false, italics: run.marks?.includes("italic") ?? false };
  return as === "inserted" ? new InsertedTextRun(options) : new DeletedTextRun(options);
}

function diffedParagraph(paragraph: RedlineParagraph, state: RedlineState): DocxTrackedParagraph {
  const verdict: Verdict = paragraph.status === "inserted" ? "inserted" : paragraph.status === "deleted" ? "deleted" : "unchanged";
  const mark = paragraphMark(verdict, state);
  return {
    children: paragraph.runs.map((run) => verdictRichRun(run, state.theme.fontSize.paragraph, verdict, state)),
    ...(mark ? { mark } : {}),
  };
}

/* ------------------------------------------------------------------ the walk */

function blockDocx(block: RedlineBlock, ctx: DocxRenderContext, state: RedlineState): (Paragraph | Table)[] {
  switch (block.status) {
    case "unchanged":
      return renderNodeToDocx(block.node, trackedCtx(ctx, state, "unchanged", []), block.path);
    case "inserted":
      return wholeBlockDocx(block.node, block.path, "inserted", ctx, state);
    case "deleted":
      return wholeBlockDocx(block.node, block.path, "deleted", ctx, state);
    case "attrsChanged":
      // Presentation only. Word's `w:pPrChange` is not modelled: the block is shown as it now reads.
      return renderNodeToDocx(block.node, trackedCtx(ctx, state, "unchanged", []), block.path);
    case "textChanged":
      return renderNodeToDocx(block.node, trackedCtx(ctx, state, "unchanged", block.fields), block.path);
    case "container":
      return containerDocx(block, ctx, state);
  }
}

/**
 * A block the edit added or removed whole. A `custom` block is the exception: its DOCX is built by
 * code we do not own (ADR-0005), so its runs cannot be marked — the change is reported by a tracked
 * marker paragraph instead, and an added block is then rendered for real underneath it.
 */
function wholeBlockDocx(
  node: DocumentNode,
  path: TreePath,
  verdict: "inserted" | "deleted",
  ctx: DocxRenderContext,
  state: RedlineState,
): (Paragraph | Table)[] {
  if (node.kind !== "custom") return renderNodeToDocx(node, trackedCtx(ctx, state, verdict, []), path);
  const note = `[Custom block ${verdict === "inserted" ? "added" : "removed"}: ${node.component}]`;
  const marker = new Paragraph({
    children: [verdictRun(note, { size: ctx.theme.fontSize.paragraph, italics: true }, verdict, state)],
    spacing: { after: twips(ctx.theme.spacing.paragraph) },
  });
  return verdict === "deleted" ? [marker] : [marker, ...renderNodeToDocx(node, trackedCtx(ctx, state, "unchanged", []), path)];
}

function containerDocx(block: Extract<RedlineBlock, { status: "container" }>, ctx: DocxRenderContext, state: RedlineState): (Paragraph | Table)[] {
  const node = block.node;
  if (node.kind === "article" && block.children.of === "body") {
    const inner: DocxRenderContext = { ...ctx, depth: ctx.depth + 1 };
    return [
      articleHeadingDocx(node, trackedCtx(ctx, state, "unchanged", block.fields), block.path),
      ...block.children.blocks.flatMap((child) => blockDocx(child, inner, state)),
    ];
  }
  if ((node.kind === "numberedList" || node.kind === "bulletList" || node.kind === "alphaList") && block.children.of === "items") {
    const kind = node.kind;
    return block.children.items.flatMap((item, index) => itemDocx(item, kind, index, ctx, state));
  }
  throw new LegalDocsError(`a ${node.kind} block holds no children — the redline model never reports it as a container`);
}

/**
 * One list item. An item added, dropped or left alone takes its verdict whole. A `changed` item whose
 * blocks were only reworded still renders as the flat model's single marked line; one that gained or
 * lost a block is expanded — the marker leads, then each block carries its own verdict.
 */
function itemDocx(
  item: RedlineListItem,
  kind: "numberedList" | "bulletList" | "alphaList",
  index: number,
  ctx: DocxRenderContext,
  state: RedlineState,
): (Paragraph | Table)[] {
  const nodes = item.blocks.map((block) => block.node);
  if (item.status === "unchanged") return renderListItemToDocx(kind, nodes, index, trackedCtx(ctx, state, "unchanged", []), item.path);
  if (item.status === "inserted" || item.status === "deleted") {
    return renderListItemToDocx(kind, nodes, index, trackedCtx(ctx, state, item.status, []), item.path);
  }
  const reworded = item.blocks.every((block) => block.status === "unchanged" || block.status === "textChanged" || block.status === "attrsChanged");
  if (reworded) {
    const fields = item.blocks.flatMap((block) => (block.status === "textChanged" ? block.fields : []));
    return renderListItemToDocx(kind, nodes, index, trackedCtx(ctx, state, "unchanged", fields), item.path);
  }
  const inner: DocxRenderContext = { ...ctx, depth: ctx.depth + 1 };
  return [docxListLead(kind, index, trackedCtx(ctx, state, "unchanged", [])), ...item.blocks.flatMap((block) => blockDocx(block, inner, state))];
}

/**
 * Changed page-header/footer slots. Furniture is section-level in Word, so it cannot carry a tracked
 * change of its own — the edited header and footer are rendered as they now read, and the difference
 * is reported as a trailing section, exactly as the HTML redline does (ADR-0011).
 */
function furnitureDocx(fields: readonly RedlineField[], theme: Theme, state: RedlineState): Paragraph[] {
  if (fields.length === 0) return [];
  const style: DocxRunStyle = { size: theme.footer.fontSize };
  return [
    new Paragraph({
      children: [new TextRun({ text: "Page header and footer", size: halfPoints(theme.fontSize.paragraph), bold: true })],
      spacing: { before: twips(theme.spacing.title), after: twips(theme.spacing.paragraph) },
    }),
    ...fields.map(
      (field) =>
        new Paragraph({
          children: [
            new TextRun({ text: `${formatTreePath(field.path)}: `, size: halfPoints(theme.footer.fontSize) }),
            ...(field.kind === "text" ? field.segments.flatMap((segment) => segmentRuns(segment, style, state)) : []),
          ],
          spacing: { after: twips(theme.spacing.paragraph) },
        }),
    ),
  ];
}
