import { LegalDocsError } from "../core/errors";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TabStopPosition,
  TextRun,
  WidthType,
} from "docx";
import type { IParagraphOptions, IParagraphRunOptions, ParagraphChild } from "docx";
import { PAGE_NUMBER_SENTINEL, PAGE_TOTAL_SENTINEL } from "../core/document-tree";
import type { PageFurniture } from "../core/document-tree";
import type {
  Align,
  DocumentBody,
  DocumentNode,
  DocumentTree,
  KeyValueRow,
  PartyIdentification,
  SignaturePlace,
} from "../core/document-tree";
import { asDocumentTree } from "../core/document-tree";
import type { TreePath } from "../core/edit/tree-path";
import type { RichRun } from "../core/rich-text";
import { MAX_LEVEL } from "../core/engine";
import { mergeTheme, type Theme } from "../theme";
import { effectivePage, PAGE_SIZES, type PageSetup } from "../core/page";
import { dispatchCustomBlock } from "../custom-block";
import type { CustomBlockRegistry, DegradationMode, OnDegrade, RenderTreeOptions } from "../custom-block";
import { eighths, halfPoints, twips } from "./theme-docx";

/** How a run of document text is styled. `size` is in points — the Renderer converts to half-points. */
export interface DocxRunStyle {
  size: number;
  bold?: boolean;
  italics?: boolean;
  color?: string;
}

/**
 * One piece of a paragraph's text. `path` addresses the editable leaf the piece came from, when it has
 * one — non-editable glue (a list marker, an article number, a separator) carries none. The plain
 * Renderer joins the pieces into a single run and ignores the addresses; the redline Renderer
 * (`redline-docx.ts`) uses them to turn just the pieces that changed into tracked runs.
 */
export interface DocxTextPart {
  text: string;
  path?: TreePath;
}

/** One paragraph a {@link DocxTrack} contributes, with an optional tracked paragraph mark. */
export interface DocxTrackedParagraph {
  children: ParagraphChild[];
  mark?: IParagraphRunOptions;
}

/**
 * The hook the redline Renderer installs on the context to take over text emission. It is absent in
 * every ordinary render, and every method is answered from one {@link RedlineDoc} — so a compare
 * document is this same visitor, not a second one that could drift from it.
 */
export interface DocxTrack {
  /** The children one paragraph's text contributes: plain runs, or `w:ins`/`w:del` where it changed. */
  text(parts: readonly DocxTextPart[], style: DocxRunStyle): ParagraphChild[];
  /** One entry per paragraph a `richText` node contributes — a diff can add or drop paragraphs. */
  richText(node: Extract<DocumentNode, { kind: "richText" }>, path: TreePath): readonly DocxTrackedParagraph[];
  /** Whether a leaf that is absent from the node nonetheless has a change to show (a deleted heading). */
  has(path: TreePath): boolean;
}

/** Everything the DOCX visitor carries down the tree. Created by {@link createDocxRenderContext}. */
export interface DocxRenderContext {
  theme: Theme;
  blocks: CustomBlockRegistry;
  degradation: DegradationMode;
  onDegrade?: OnDegrade;
  /** Nesting depth — Word is flat, so nesting becomes a left indent on the paragraph. */
  depth: number;
  /** Redline only: takes over text emission (see {@link DocxTrack}). */
  track?: DocxTrack;
  /** Redline only: a tracked paragraph mark (`w:rPr/w:ins|w:del` in `w:pPr`) for every paragraph. */
  paragraphMark?: IParagraphRunOptions;
}

/**
 * The DOCX Renderer: a visitor over the DocumentTree producing `docx` library objects (ADR-0007).
 * Word has no nested block container, so nested nodes flatten into a flat `(Paragraph | Table)[]` with
 * indentation/markers carried as paragraph properties. The library handles XML escaping.
 */
export async function renderTreeToDocx(input: DocumentTree | DocumentBody, options: RenderTreeOptions = {}): Promise<Buffer> {
  // `async` so a synchronous build error (unregistered component, throw-mode degradation) surfaces as
  // a rejected promise rather than a sync throw.
  const tree = asDocumentTree(input);
  const ctx = createDocxRenderContext(options);
  const children = tree.body.flatMap((node, index) => renderNodeToDocx(node, ctx, ["body", index]));
  return Packer.toBuffer(new Document(docxDocumentOptions(tree, ctx, children)));
}

/** The visitor's context for a set of render options. The redline Renderer adds its own hooks to it. */
export function createDocxRenderContext(options: RenderTreeOptions = {}): DocxRenderContext {
  return {
    theme: mergeTheme(options.theme),
    blocks: options.customBlocks ?? {},
    degradation: options.degradation ?? "placeholder",
    onDegrade: options.onDegrade,
    depth: 0,
  };
}

/**
 * The `Document` options a rendered body turns into: the document-default run font (the reader's app
 * substitutes if it lacks the family), the section's page geometry and the page furniture. Shared with
 * the redline Renderer so a compare document has the same geometry as the document it compares.
 */
export function docxDocumentOptions(tree: DocumentTree, ctx: DocxRenderContext, children: readonly (Paragraph | Table)[]) {
  const theme = ctx.theme;
  return {
    styles: { default: { document: { run: { font: theme.font.family } } } },
    sections: [
      {
        properties: { page: pageProperties(theme, tree.page) },
        ...(tree.header ? { headers: { default: new Header({ children: [furnitureParagraph(tree.header, "header", theme)] }) } } : {}),
        ...(tree.footer ? { footers: { default: new Footer({ children: [furnitureParagraph(tree.footer, "footer", theme)] }) } } : {}),
        children: [...children],
      },
    ],
  };
}

/**
 * Explicit section page geometry — without it Word applies its own defaults (Letter-ish size, 1-inch
 * margins) and ignores the theme entirely. Dimensions are always the portrait values from PAGE_SIZES;
 * the docx library swaps w:w/w:h itself when the orientation is landscape. The single `padding` token
 * maps to all four page margins, mirroring the PDF renderer's uniform Page padding.
 */
function pageProperties(theme: Theme, override?: PageSetup) {
  const page = effectivePage(theme, override);
  const { width, height } = PAGE_SIZES[page.size];
  const margin = twips(theme.page.padding);
  return {
    size: {
      width: twips(width),
      height: twips(height),
      orientation: page.orientation === "landscape" ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
    },
    margin: { top: margin, right: margin, bottom: margin, left: margin },
  };
}

/**
 * Render one node at `path`. `path` addresses the node in the DocumentTree (the same scheme `locate`
 * and the HTML Renderer's `data-path` use) and is only consulted through {@link DocxTrack} — an
 * ordinary render neither reads nor emits it.
 */
export function renderNodeToDocx(node: DocumentNode, ctx: DocxRenderContext, path: TreePath): (Paragraph | Table)[] {
  switch (node.kind) {
    case "title":
      return [
        para(ctx, {
          children: runs(ctx, [{ text: node.text, path: [...path, "text"] }], ctx.theme.fontSize.title, { bold: true }),
          spacing: { after: twips(ctx.theme.spacing.title) },
          ...alignment(node.align ?? ctx.theme.align.title),
          // Titles have no Theme indent default (0); only a per-block override indents them.
          ...blockIndent(ctx, node.indent?.firstLine ?? 0, node.indent?.left ?? 0),
        }),
      ];
    case "paragraph":
      return [
        para(ctx, {
          children: runs(ctx, [{ text: node.text, path: [...path, "text"] }], ctx.theme.fontSize.paragraph),
          spacing: { after: twips(ctx.theme.spacing.paragraph) },
          ...alignment(node.align ?? ctx.theme.align.paragraph),
          ...blockIndent(ctx, node.indent?.firstLine ?? ctx.theme.indent.firstLine, node.indent?.left ?? ctx.theme.indent.block),
        }),
      ];
    case "richText":
      if (ctx.track) {
        return ctx.track.richText(node, path).map((entry) => richTextParagraph(entry.children, ctx, entry.mark));
      }
      return node.value.blocks.map((block) => richTextParagraph(block.runs.map((r) => richRun(r, ctx)), ctx));
    case "article":
      return articleDocx(node, ctx, path);
    case "numberedList":
    case "bulletList":
    case "alphaList":
      return node.items.flatMap((item, index) => renderListItemToDocx(node.kind, item, index, ctx, [...path, "items", index]));
    case "partyHeader":
      return partyDocx(node.party, node.roleLabel, ctx, path);
    case "keyValueTable":
      return [keyValueTableDocx(node.rows, ctx, path)];
    case "signatures":
      return [signaturesDocx(node.places, ctx, path)];
    case "custom":
      return customDocx(node, ctx);
    default: {
      const unhandled: never = node;
      throw new LegalDocsError(`Unsupported node kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** A paragraph carrying the context's tracked paragraph mark, if it has one (redline only). */
function para(ctx: DocxRenderContext, options: IParagraphOptions, mark = ctx.paragraphMark): Paragraph {
  return new Paragraph(mark ? { ...options, run: mark } : options);
}

function run(text: string, sizePt: number, opts: { bold?: boolean; italics?: boolean; color?: string } = {}): TextRun {
  return new TextRun({ text, size: halfPoints(sizePt), ...opts });
}

/**
 * The children one paragraph's text contributes. Without a {@link DocxTrack} the parts are joined into
 * a single run, exactly as if they had been one string — so installing the hook is the only thing that
 * changes the output.
 */
function runs(
  ctx: DocxRenderContext,
  parts: readonly DocxTextPart[],
  sizePt: number,
  opts: { bold?: boolean; italics?: boolean; color?: string } = {},
): ParagraphChild[] {
  if (ctx.track) return ctx.track.text(parts, { size: sizePt, ...opts });
  return [run(parts.map((part) => part.text).join(""), sizePt, opts)];
}

/**
 * A header/footer paragraph: a classic Word three-column layout via center + right tab stops. Each
 * slot's page-number sentinels are split into `PageNumber` field runs (which Word fills per page); the
 * text between them becomes plain runs. `theme.header`/`footer` drives size and colour.
 */
export function furnitureParagraph(furniture: PageFurniture, kind: "header" | "footer", theme: Theme): Paragraph {
  const style = kind === "header" ? theme.header : theme.footer;
  const runOpts = { size: halfPoints(style.fontSize), color: hex(style.color) };
  // Fresh tab run per position — a docx node should not be shared across two slots in the graph.
  const tab = (): TextRun => new TextRun({ text: "\t", ...runOpts });
  return new Paragraph({
    tabStops: [
      { type: TabStopType.CENTER, position: TabStopPosition.MAX / 2 },
      { type: TabStopType.RIGHT, position: TabStopPosition.MAX },
    ],
    children: [...slotRuns(furniture.left, runOpts), tab(), ...slotRuns(furniture.center, runOpts), tab(), ...slotRuns(furniture.right, runOpts)],
  });
}

/** Split a resolved furniture slot on the page-number sentinels into text runs + `PageNumber` field runs. */
function slotRuns(slot: string | undefined, runOpts: { size: number; color: string }): TextRun[] {
  if (!slot) return [];
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = slot.split(new RegExp(`(${escape(PAGE_NUMBER_SENTINEL)}|${escape(PAGE_TOTAL_SENTINEL)})`));
  return parts
    .filter((part) => part !== "")
    .map((part) => {
      if (part === PAGE_NUMBER_SENTINEL) return new TextRun({ children: [PageNumber.CURRENT], ...runOpts });
      if (part === PAGE_TOTAL_SENTINEL) return new TextRun({ children: [PageNumber.TOTAL_PAGES], ...runOpts });
      return new TextRun({ text: part, ...runOpts });
    });
}

/**
 * Left indent (twips) for the current nesting depth; absent at the top level. The flat model uses one
 * depth-based indent token (`article.indentPerLevel`) for all nesting — per-node spacing tokens
 * (`list.indent`, `partyHeader.gap`, `signatures.columnGap`, …) are not all honoured; that is the
 * documented ADR-0007 approximation.
 */
export function docxIndent(ctx: DocxRenderContext): { indent?: { left: number } } {
  return ctx.depth > 0 ? { indent: { left: twips(ctx.theme.article.indentPerLevel * ctx.depth) } } : {};
}

/**
 * Title/paragraph indent (twips): the nesting depth's left indent plus the effective block-left and
 * first-line indents (ADR-0008). Emitted only when non-zero, so the all-default case adds no XML.
 */
function blockIndent(ctx: DocxRenderContext, firstLinePt: number, leftPt: number): { indent?: { left?: number; firstLine?: number } } {
  const depthLeft = ctx.depth > 0 ? twips(ctx.theme.article.indentPerLevel * ctx.depth) : 0;
  const left = depthLeft + twips(leftPt);
  const firstLine = twips(firstLinePt);
  const out: { left?: number; firstLine?: number } = {
    ...(left > 0 ? { left } : {}),
    ...(firstLine > 0 ? { firstLine } : {}),
  };
  return "left" in out || "firstLine" in out ? { indent: out } : {};
}

const ALIGN: Record<Align, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED, // note: JUSTIFIED serializes to OOXML `w:jc w:val="both"`.
};

/**
 * Paragraph alignment property. Omitted for `left` — Word's default — so the common case adds no XML
 * (existing golden output stays clean); `center`/`right`/`justify` emit `alignment` (ADR-0008).
 */
function alignment(a: Align): { alignment?: (typeof AlignmentType)[keyof typeof AlignmentType] } {
  return a === "left" ? {} : { alignment: ALIGN[a] };
}

/**
 * `align` defaults to `left` — NOT the paragraph Theme default — because the non-node callers
 * (`partyDocx`) are own-layout nodes that ADR-0008 keeps out of scope; a themed paragraph alignment
 * must not leak into them. The genuine `paragraph` node passes `node.align ?? theme.align.paragraph`
 * explicitly, so real paragraphs are unaffected.
 */
function textParagraph(parts: readonly DocxTextPart[], ctx: DocxRenderContext, align: Align = "left"): Paragraph {
  return para(ctx, {
    children: runs(ctx, parts, ctx.theme.fontSize.paragraph),
    spacing: { after: twips(ctx.theme.spacing.paragraph) },
    ...alignment(align),
    ...docxIndent(ctx),
  });
}

function richTextParagraph(children: ParagraphChild[], ctx: DocxRenderContext, mark?: IParagraphRunOptions): Paragraph {
  return para(
    ctx,
    {
      children,
      spacing: { after: twips(ctx.theme.spacing.paragraph) },
      ...docxIndent(ctx),
    },
    mark ?? ctx.paragraphMark,
  );
}

/** A rich-text run as a plain `TextRun`; the redline builds its tracked counterpart the same way. */
export function docxRichRun(r: RichRun, sizePt: number): TextRun {
  return run(r.text, sizePt, { bold: r.marks?.includes("bold") ?? false, italics: r.marks?.includes("italic") ?? false });
}

function richRun(r: RichRun, ctx: DocxRenderContext): TextRun {
  return docxRichRun(r, ctx.theme.fontSize.paragraph);
}

/** An article's heading line — the number, then the heading, which is the only editable half. */
export function articleHeadingDocx(node: Extract<DocumentNode, { kind: "article" }>, ctx: DocxRenderContext, path: TreePath): Paragraph {
  const level = Math.min(Math.max(node.level, 1), MAX_LEVEL);
  const headingSize = ctx.theme.article.headingFontSize[level - 1] ?? ctx.theme.article.headingFontSize[0];
  // A heading the edit deleted is gone from the node but still has a change to show, so both are asked.
  const headingPath = [...path, "heading"];
  const hasHeading = node.heading !== undefined || (ctx.track?.has(headingPath) ?? false);
  const parts: DocxTextPart[] = hasHeading
    ? [{ text: `${node.no} ` }, { text: node.heading ?? "", path: headingPath }]
    : [{ text: node.no }];
  return para(ctx, {
    children: runs(ctx, parts, headingSize, { bold: true }),
    spacing: { after: twips(ctx.theme.spacing.paragraph) },
    ...docxIndent(ctx),
  });
}

function articleDocx(node: Extract<DocumentNode, { kind: "article" }>, ctx: DocxRenderContext, path: TreePath): (Paragraph | Table)[] {
  // Word is flat: the body is indented one level deeper than its heading (ADR-0007), unlike the PDF/
  // HTML renderers where a heading and its body share the article's indent.
  const inner: DocxRenderContext = { ...ctx, depth: ctx.depth + 1 };
  const body = node.body.flatMap((child, index) => renderNodeToDocx(child, inner, [...path, "body", index]));
  return [articleHeadingDocx(node, ctx, path), ...body];
}

/** The marker text a list kind puts in front of its `index`-th item. */
export function docxListMarker(kind: "numberedList" | "bulletList" | "alphaList", index: number): string {
  if (kind === "bulletList") return "• ";
  return kind === "alphaList" ? `${String.fromCharCode(97 + index)}. ` : `${index + 1}. `;
}

/**
 * One list item at `path`. A plain-text item becomes a single paragraph with the manual marker prefix
 * (ADR-0007 flat-model approximation; inline formatting within the item is flattened to text). Known
 * limitation: a per-block `align` on a list-item paragraph is not carried here (lists are out of
 * ADR-0008 scope); PDF/HTML do honour it. Item-level alignment can be added later.
 */
export function renderListItemToDocx(
  kind: "numberedList" | "bulletList" | "alphaList",
  item: readonly DocumentNode[],
  index: number,
  ctx: DocxRenderContext,
  path: TreePath,
): (Paragraph | Table)[] {
  const itemCtx: DocxRenderContext = { ...ctx, depth: ctx.depth + 1 };
  const marker = docxListMarker(kind, index);
  if (item.every(isTextNode)) {
    // The marker carries the item's own path so a comment on the item still has something to anchor to;
    // each text node contributes its own part, so a reworded item is tracked word by word.
    const parts: DocxTextPart[] = [{ text: marker, path }];
    let wrote = false;
    item.forEach((node, at) => {
      const text = textOf(node);
      if (text.length === 0) return;
      if (wrote) parts.push({ text: " " });
      parts.push(node.kind === "richText" ? { text } : { text, path: [...path, at, "text"] });
      wrote = true;
    });
    return [
      para(ctx, {
        children: runs(ctx, parts, ctx.theme.fontSize.paragraph),
        spacing: { after: twips(ctx.theme.list.gap) },
        ...docxIndent(itemCtx),
      }),
    ];
  }
  // An item with non-text content (e.g. a Custom block) is rendered in full so nothing is silently
  // dropped and the Degradation contract still fires; the marker leads as its own paragraph.
  return [docxListLead(kind, index, ctx), ...item.flatMap((node, at) => renderNodeToDocx(node, itemCtx, [...path, at]))];
}

/** The marker on a line of its own, for an item whose content is not one run of text. */
export function docxListLead(kind: "numberedList" | "bulletList" | "alphaList", index: number, ctx: DocxRenderContext): Paragraph {
  return para(ctx, {
    children: runs(ctx, [{ text: docxListMarker(kind, index).trim() }], ctx.theme.fontSize.paragraph),
    ...docxIndent({ ...ctx, depth: ctx.depth + 1 }),
  });
}

function isTextNode(node: DocumentNode): boolean {
  return node.kind === "title" || node.kind === "paragraph" || node.kind === "richText";
}

function partyDocx(party: PartyIdentification, roleLabel: string, ctx: DocxRenderContext, path: TreePath): Paragraph[] {
  const out = [
    para(ctx, {
      children: runs(ctx, [{ text: roleLabel, path: [...path, "roleLabel"] }], ctx.theme.partyHeader.roleFontSize, { bold: true }),
      ...docxIndent(ctx),
    }),
    textParagraph([{ text: party.name, path: [...path, "party", "name"] }], ctx),
  ];
  // An optional line the edit deleted is gone from the party but still has a change to show.
  for (const key of ["idNumber", "address"] as const) {
    const leaf = [...path, "party", key];
    if (party[key] === undefined && !(ctx.track?.has(leaf) ?? false)) continue;
    out.push(textParagraph([{ text: party[key] ?? "", path: leaf }], ctx));
  }
  return out;
}

function keyValueTableDocx(rows: KeyValueRow[], ctx: DocxRenderContext, path: TreePath): Table {
  const border = { style: BorderStyle.SINGLE, size: eighths(0.75), color: hex(ctx.theme.table.borderColor) };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: rows.map(
      (row, at) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: twips(ctx.theme.table.labelWidth), type: WidthType.DXA },
              children: [
                para(ctx, { children: runs(ctx, [{ text: row.label, path: [...path, "rows", at, "label"] }], ctx.theme.table.fontSize, { bold: true }) }),
              ],
            }),
            new TableCell({
              children: [para(ctx, { children: runs(ctx, [{ text: row.value, path: [...path, "rows", at, "value"] }], ctx.theme.table.fontSize) })],
            }),
          ],
        }),
    ),
  });
}

function signaturesDocx(places: SignaturePlace[], ctx: DocxRenderContext, path: TreePath): Table {
  const line = {
    top: { style: BorderStyle.SINGLE, size: eighths(ctx.theme.signatures.lineWidth), color: hex(ctx.theme.signatures.lineColor) },
  };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: noTableBorders(),
    rows: [
      new TableRow({
        children: places.map((place, at) => {
          const cells = [
            para(ctx, { border: line, spacing: { before: twips(ctx.theme.signatures.lineSpace) } }),
            para(ctx, { children: runs(ctx, [{ text: place.name, path: [...path, "places", at, "name"] }], ctx.theme.signatures.fontSize) }),
          ];
          const rolePath = [...path, "places", at, "role"];
          if (place.role !== undefined || (ctx.track?.has(rolePath) ?? false)) {
            cells.push(
              para(ctx, {
                children: runs(ctx, [{ text: place.role ?? "", path: rolePath }], ctx.theme.signatures.fontSize, {
                  color: hex(ctx.theme.signatures.roleColor),
                }),
              }),
            );
          }
          return new TableCell({ children: cells });
        }),
      }),
    ],
  });
}

function customDocx(node: Extract<DocumentNode, { kind: "custom" }>, ctx: DocxRenderContext): (Paragraph | Table)[] {
  const result = dispatchCustomBlock(node, "docx", ctx);
  // Degradation marker policy (see dispatchCustomBlock): plain body text in the default paragraph style.
  if ("marker" in result) {
    return [
      para(ctx, {
        children: [new TextRun({ text: result.marker, color: hex(ctx.theme.color.text) })],
      }),
    ];
  }
  return result.rendered;
}

function textOf(node: DocumentNode): string {
  switch (node.kind) {
    case "title":
    case "paragraph":
      return node.text;
    case "richText":
      return node.value.blocks.map((b) => b.runs.map((r) => r.text).join("")).join(" ");
    default:
      // Unreachable: only reached for text nodes; non-text items take the full-render branch.
      return "";
  }
}

function hex(color: string): string {
  return color.replace(/^#/, "");
}

function noTableBorders() {
  const none = { style: BorderStyle.NONE, size: 0, color: "auto" };
  return { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
}
