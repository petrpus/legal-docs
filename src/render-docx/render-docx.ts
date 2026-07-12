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
import type { RichParagraph, RichRun } from "../core/rich-text";
import { MAX_LEVEL } from "../core/engine";
import { mergeTheme, type Theme } from "../theme";
import { effectivePage, PAGE_SIZES, type PageSetup } from "../core/page";
import { dispatchCustomBlock } from "../custom-block";
import type { CustomBlockRegistry, DegradationMode, OnDegrade, RenderTreeOptions } from "../custom-block";
import { eighths, halfPoints, twips } from "./theme-docx";

interface DocxCtx {
  theme: Theme;
  blocks: CustomBlockRegistry;
  degradation: DegradationMode;
  onDegrade?: OnDegrade;
  /** Nesting depth — Word is flat, so nesting becomes a left indent on the paragraph. */
  depth: number;
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
  const theme = mergeTheme(options.theme);
  const ctx: DocxCtx = { theme, blocks: options.customBlocks ?? {}, degradation: options.degradation ?? "placeholder", onDegrade: options.onDegrade, depth: 0 };
  const children = tree.body.flatMap((node) => nodeToDocx(node, ctx));
  // Set the document-default run font (the reader's app substitutes if it lacks the family).
  const doc = new Document({
    styles: { default: { document: { run: { font: theme.font.family } } } },
    sections: [
      {
        properties: { page: pageProperties(theme, tree.page) },
        ...(tree.header ? { headers: { default: new Header({ children: [furnitureParagraph(tree.header, "header", theme)] }) } } : {}),
        ...(tree.footer ? { footers: { default: new Footer({ children: [furnitureParagraph(tree.footer, "footer", theme)] }) } } : {}),
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
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

function nodeToDocx(node: DocumentNode, ctx: DocxCtx): (Paragraph | Table)[] {
  switch (node.kind) {
    case "title":
      return [
        new Paragraph({
          children: [run(node.text, ctx.theme.fontSize.title, { bold: true })],
          spacing: { after: twips(ctx.theme.spacing.title) },
          ...alignment(node.align ?? ctx.theme.align.title),
          // Titles have no Theme indent default (0); only a per-block override indents them.
          ...blockIndent(ctx, node.indent?.firstLine ?? 0, node.indent?.left ?? 0),
        }),
      ];
    case "paragraph":
      return [
        new Paragraph({
          children: [run(node.text, ctx.theme.fontSize.paragraph)],
          spacing: { after: twips(ctx.theme.spacing.paragraph) },
          ...alignment(node.align ?? ctx.theme.align.paragraph),
          ...blockIndent(ctx, node.indent?.firstLine ?? ctx.theme.indent.firstLine, node.indent?.left ?? ctx.theme.indent.block),
        }),
      ];
    case "richText":
      return node.value.blocks.map((block) => richParagraph(block, ctx));
    case "article":
      return articleDocx(node, ctx);
    case "numberedList":
      return listDocx(node.items, ctx, (i) => `${i + 1}. `);
    case "bulletList":
      return listDocx(node.items, ctx, () => "• ");
    case "alphaList":
      return listDocx(node.items, ctx, (i) => `${String.fromCharCode(97 + i)}. `);
    case "partyHeader":
      return partyDocx(node.party, node.roleLabel, ctx);
    case "keyValueTable":
      return [keyValueTableDocx(node.rows, ctx)];
    case "signatures":
      return [signaturesDocx(node.places, ctx)];
    case "custom":
      return customDocx(node, ctx);
    default: {
      const unhandled: never = node;
      throw new LegalDocsError(`Unsupported node kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

function run(text: string, sizePt: number, opts: { bold?: boolean; italics?: boolean; color?: string } = {}): TextRun {
  return new TextRun({ text, size: halfPoints(sizePt), ...opts });
}

/**
 * A header/footer paragraph: a classic Word three-column layout via center + right tab stops. Each
 * slot's page-number sentinels are split into `PageNumber` field runs (which Word fills per page); the
 * text between them becomes plain runs. `theme.header`/`footer` drives size and colour.
 */
function furnitureParagraph(furniture: PageFurniture, kind: "header" | "footer", theme: Theme): Paragraph {
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
function indent(ctx: DocxCtx): { indent?: { left: number } } {
  return ctx.depth > 0 ? { indent: { left: twips(ctx.theme.article.indentPerLevel * ctx.depth) } } : {};
}

/**
 * Title/paragraph indent (twips): the nesting depth's left indent plus the effective block-left and
 * first-line indents (ADR-0008). Emitted only when non-zero, so the all-default case adds no XML.
 */
function blockIndent(ctx: DocxCtx, firstLinePt: number, leftPt: number): { indent?: { left?: number; firstLine?: number } } {
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
function textParagraph(text: string, ctx: DocxCtx, align: Align = "left"): Paragraph {
  return new Paragraph({
    children: [run(text, ctx.theme.fontSize.paragraph)],
    spacing: { after: twips(ctx.theme.spacing.paragraph) },
    ...alignment(align),
    ...indent(ctx),
  });
}

function richParagraph(block: RichParagraph, ctx: DocxCtx): Paragraph {
  return new Paragraph({
    children: block.runs.map((r) => richRun(r, ctx)),
    spacing: { after: twips(ctx.theme.spacing.paragraph) },
    ...indent(ctx),
  });
}

function richRun(r: RichRun, ctx: DocxCtx): TextRun {
  return run(r.text, ctx.theme.fontSize.paragraph, {
    bold: r.marks?.includes("bold") ?? false,
    italics: r.marks?.includes("italic") ?? false,
  });
}

function articleDocx(node: Extract<DocumentNode, { kind: "article" }>, ctx: DocxCtx): (Paragraph | Table)[] {
  const headingText = node.heading === undefined ? node.no : `${node.no} ${node.heading}`;
  const level = Math.min(Math.max(node.level, 1), MAX_LEVEL);
  const headingSize = ctx.theme.article.headingFontSize[level - 1] ?? ctx.theme.article.headingFontSize[0];
  const heading = new Paragraph({
    children: [run(headingText, headingSize, { bold: true })],
    spacing: { after: twips(ctx.theme.spacing.paragraph) },
    ...indent(ctx),
  });
  // Word is flat: the body is indented one level deeper than its heading (ADR-0007), unlike the PDF/
  // HTML renderers where a heading and its body share the article's indent.
  const body = node.body.flatMap((child) => nodeToDocx(child, { ...ctx, depth: ctx.depth + 1 }));
  return [heading, ...body];
}

function listDocx(items: DocumentNode[][], ctx: DocxCtx, marker: (i: number) => string): (Paragraph | Table)[] {
  const itemCtx: DocxCtx = { ...ctx, depth: ctx.depth + 1 };
  return items.flatMap((item, i) => {
    if (item.every(isTextNode)) {
      // Common case: a plain-text item → one paragraph with the manual marker prefix (ADR-0007
      // flat-model approximation; inline formatting within the item is flattened to text). Known
      // limitation: a per-block `align` on a list-item paragraph is not carried here (lists are
      // out of ADR-0008 scope); PDF/HTML do honour it. Item-level alignment can be added later.
      return [
        new Paragraph({
          children: [run(`${marker(i)}${plainText(item)}`, ctx.theme.fontSize.paragraph)],
          spacing: { after: twips(ctx.theme.list.gap) },
          ...indent(itemCtx),
        }),
      ];
    }
    // An item with non-text content (e.g. a Custom block) is rendered in full so nothing is silently
    // dropped and the Degradation contract still fires; the marker leads as its own paragraph.
    const lead = new Paragraph({
      children: [run(marker(i).trim(), ctx.theme.fontSize.paragraph)],
      ...indent(itemCtx),
    });
    return [lead, ...item.flatMap((node) => nodeToDocx(node, itemCtx))];
  });
}

function isTextNode(node: DocumentNode): boolean {
  return node.kind === "title" || node.kind === "paragraph" || node.kind === "richText";
}

function partyDocx(party: PartyIdentification, roleLabel: string, ctx: DocxCtx): Paragraph[] {
  const out = [
    new Paragraph({
      children: [run(roleLabel, ctx.theme.partyHeader.roleFontSize, { bold: true })],
      ...indent(ctx),
    }),
    textParagraph(party.name, ctx),
  ];
  if (party.idNumber !== undefined) out.push(textParagraph(party.idNumber, ctx));
  if (party.address !== undefined) out.push(textParagraph(party.address, ctx));
  return out;
}

function keyValueTableDocx(rows: KeyValueRow[], ctx: DocxCtx): Table {
  const border = { style: BorderStyle.SINGLE, size: eighths(0.75), color: hex(ctx.theme.table.borderColor) };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: rows.map(
      (row) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: twips(ctx.theme.table.labelWidth), type: WidthType.DXA },
              children: [new Paragraph({ children: [run(row.label, ctx.theme.table.fontSize, { bold: true })] })],
            }),
            new TableCell({
              children: [new Paragraph({ children: [run(row.value, ctx.theme.table.fontSize)] })],
            }),
          ],
        }),
    ),
  });
}

function signaturesDocx(places: SignaturePlace[], ctx: DocxCtx): Table {
  const line = {
    top: { style: BorderStyle.SINGLE, size: eighths(ctx.theme.signatures.lineWidth), color: hex(ctx.theme.signatures.lineColor) },
  };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: noTableBorders(),
    rows: [
      new TableRow({
        children: places.map((place) => {
          const cells = [
            new Paragraph({ border: line, spacing: { before: twips(ctx.theme.signatures.lineSpace) } }),
            new Paragraph({ children: [run(place.name, ctx.theme.signatures.fontSize)] }),
          ];
          if (place.role !== undefined) {
            cells.push(
              new Paragraph({
                children: [run(place.role, ctx.theme.signatures.fontSize, { color: hex(ctx.theme.signatures.roleColor) })],
              }),
            );
          }
          return new TableCell({ children: cells });
        }),
      }),
    ],
  });
}

function customDocx(node: Extract<DocumentNode, { kind: "custom" }>, ctx: DocxCtx): (Paragraph | Table)[] {
  const result = dispatchCustomBlock(node, "docx", ctx);
  // Degradation marker policy (see dispatchCustomBlock): plain body text in the default paragraph style.
  if ("marker" in result) {
    return [
      new Paragraph({
        children: [new TextRun({ text: result.marker, color: hex(ctx.theme.color.text) })],
      }),
    ];
  }
  return result.rendered;
}

/** Concatenated plain text of an all-text list item (title / paragraph / richText only). */
function plainText(nodes: DocumentNode[]): string {
  return nodes.map(textOf).filter((t) => t.length > 0).join(" ");
}

function textOf(node: DocumentNode): string {
  switch (node.kind) {
    case "title":
    case "paragraph":
      return node.text;
    case "richText":
      return node.value.blocks.map((b) => b.runs.map((r) => r.text).join("")).join(" ");
    default:
      // Unreachable: plainText only runs over text nodes; non-text items take the full-render branch.
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
