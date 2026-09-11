import { LegalDocsError } from "../core/errors";
import type {
  Align,
  BlockIndent,
  DocumentBody,
  DocumentNode,
  DocumentTree,
  KeyValueRow,
  PartyIdentification,
  SignaturePlace,
} from "../core/document-tree";
import { asDocumentTree } from "../core/document-tree";
import type { RichRun, RichTextV1 } from "../core/rich-text";
import { mergeTheme, type Theme } from "../theme";
import { dispatchCustomBlock } from "../custom-block";
import type { CustomBlockRegistry, DegradationMode, OnDegrade, RenderTreeOptions } from "../custom-block";
import { formatTreePath, type TreePath } from "../core/edit/tree-path";
import { escapeHtml } from "./escape";
import { themeCss } from "./theme-css";

/** HTML-only render options: the shared tree options plus what only this Renderer can answer. */
export interface RenderHtmlOptions extends RenderTreeOptions {
  /**
   * Emit a `data-path` attribute (the canonical tree path, `/body/2/items/0`) on every block element,
   * so a UI can map a click in the rendered document back to an editable location (PRD #147). Off by
   * default: exported documents carry no editing metadata, and the default output is byte-identical
   * to what this Renderer produced before the option existed.
   */
  emitPaths?: boolean;
}

/**
 * The state one HTML render carries. Built by {@link createHtmlRenderContext} and passed to
 * {@link renderNodeToHtml}, so the redline and review Renderers can render an untouched node exactly
 * as the plain Renderer does instead of re-implementing the visitor.
 */
export interface HtmlRenderContext {
  blocks: CustomBlockRegistry;
  degradation: DegradationMode;
  onDegrade?: OnDegrade;
  theme: Theme;
  emitPaths: boolean;
}

/** Resolve render options (theme merge, degradation default) into a {@link HtmlRenderContext}. */
export function createHtmlRenderContext(options: RenderHtmlOptions = {}): HtmlRenderContext {
  return {
    blocks: options.customBlocks ?? {},
    degradation: options.degradation ?? "placeholder",
    onDegrade: options.onDegrade,
    theme: mergeTheme(options.theme),
    emitPaths: options.emitPaths ?? false,
  };
}

/**
 * The HTML Renderer: a visitor over the DocumentTree, building HTML strings directly (no react-dom).
 * Output is a self-contained `<div class="legal-doc">` fragment with a scoped `<style>`. All
 * core-emitted text is escaped; a Custom block's HTML is trusted and inserted raw.
 */
export function renderTreeToHtml(input: DocumentTree | DocumentBody, options: RenderHtmlOptions = {}): string {
  const tree = asDocumentTree(input);
  const cx = createHtmlRenderContext(options);
  // HTML is a page-less fragment, so page header/footer furniture (`tree.header`/`tree.footer`) is
  // intentionally ignored here — it is paged-output-only (PDF/DOCX), like `theme.page.*` (ADR-0011).
  const body = tree.body.map((node, index) => renderNodeToHtml(node, cx, ["body", index])).join("");
  return `<div class="legal-doc"><style>${themeCss(cx.theme)}</style>${body}</div>`;
}

/**
 * Render one DocumentNode to its HTML block. `path` is the node's location in the tree it came from —
 * used only to emit `data-path` when the context asks for it, but required so a caller rendering a
 * node out of context (the redline and review Renderers) cannot silently emit a wrong address.
 */
export function renderNodeToHtml(node: DocumentNode, cx: HtmlRenderContext, path: TreePath): string {
  switch (node.kind) {
    case "title":
      // Per-block `align`/`indent` override the class default via inline style. Both are guarded at
      // assembly (`align` to the closed enum, `indent` to finite numbers), so they are safe unescaped;
      // `text` is still escaped.
      return `<h1 class="title"${blockStyle(node)}${pathAttr(cx, path)}>${escapeHtml(node.text)}</h1>`;
    case "paragraph":
      return `<p${blockStyle(node)}${pathAttr(cx, path)}>${escapeHtml(node.text)}</p>`;
    case "richText":
      return richTextHtml(node.value, cx, path);
    case "article": {
      const heading =
        node.heading === undefined
          ? escapeHtml(node.no)
          : `${escapeHtml(node.no)} ${escapeHtml(node.heading)}`;
      const body = node.body.map((child, index) => renderNodeToHtml(child, cx, [...path, "body", index])).join("");
      // `node.level` is a typed number (digits only), so it is safe in the attribute without escaping.
      return `<section class="article" data-level="${node.level}"${pathAttr(cx, path)}><div class="article__heading">${heading}</div>${body}</section>`;
    }
    case "numberedList":
      return listHtml(node.items, "ol", "", cx, path);
    case "bulletList":
      return listHtml(node.items, "ul", "", cx, path);
    case "alphaList":
      return listHtml(node.items, "ol", " list--alpha", cx, path);
    case "partyHeader":
      return partyHeaderHtml(node.party, node.roleLabel, cx, path);
    case "keyValueTable":
      return keyValueTableHtml(node.rows, cx, path);
    case "signatures":
      return signaturesHtml(node.places, cx, path);
    case "custom":
      return customHtml(node, cx, path);
    default: {
      const unhandled: never = node;
      throw new LegalDocsError(`Unsupported node kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * ` data-path="…"` for a block, or "" when the context does not emit paths. The value is escaped like
 * any other attribute: a path is built from document-model keys and indices today, but it travels from
 * an Edit set through a UI, so it is not trusted here.
 */
function pathAttr(cx: HtmlRenderContext, path: TreePath): string {
  return cx.emitPaths ? ` data-path="${escapeHtml(formatTreePath(path))}"` : "";
}

/** Inline `style` for per-block alignment/indent overrides, or "" to fall back to the Theme's class CSS. */
function blockStyle(node: { align?: Align; indent?: BlockIndent }): string {
  const parts: string[] = [];
  if (node.align !== undefined) parts.push(`text-align:${node.align}`);
  if (node.indent?.firstLine !== undefined) parts.push(`text-indent:${node.indent.firstLine}px`);
  if (node.indent?.left !== undefined) parts.push(`margin-left:${node.indent.left}px`);
  return parts.length === 0 ? "" : ` style="${parts.join(";")}"`;
}

function richTextHtml(value: RichTextV1, cx: HtmlRenderContext, path: TreePath): string {
  const paragraphs = value.blocks
    .map((block) => `<p>${block.runs.map(runHtml).join("")}</p>`)
    .join("");
  // The path addresses the whole `richText` node: its value is edited as one RichTextV1 (`locate`),
  // so the inner paragraphs are not separately addressable.
  return `<div class="rich"${pathAttr(cx, path)}>${paragraphs}</div>`;
}

function runHtml(run: RichRun): string {
  let text = escapeHtml(run.text);
  if (run.marks?.includes("bold")) text = `<strong>${text}</strong>`;
  if (run.marks?.includes("italic")) text = `<em>${text}</em>`;
  return text;
}

function listHtml(items: DocumentNode[][], tag: "ol" | "ul", extraClass: string, cx: HtmlRenderContext, path: TreePath): string {
  const lis = items
    .map((item, index) => {
      const itemPath = [...path, "items", index];
      const children = item.map((child, at) => renderNodeToHtml(child, cx, [...itemPath, at])).join("");
      // A list item is itself an addressable position (`insertListItem`/`removeListItem`), so it gets
      // its own path as well as the nodes inside it.
      return `<li${pathAttr(cx, itemPath)}>${children}</li>`;
    })
    .join("");
  return `<${tag} class="list${extraClass}"${pathAttr(cx, path)}>${lis}</${tag}>`;
}

function partyHeaderHtml(party: PartyIdentification, roleLabel: string, cx: HtmlRenderContext, path: TreePath): string {
  const lines = [`<div class="party__name">${escapeHtml(party.name)}</div>`];
  if (party.idNumber !== undefined) lines.push(`<div>${escapeHtml(party.idNumber)}</div>`);
  if (party.address !== undefined) lines.push(`<div>${escapeHtml(party.address)}</div>`);
  return `<div class="party"${pathAttr(cx, path)}><div class="party__role">${escapeHtml(roleLabel)}</div>${lines.join("")}</div>`;
}

function keyValueTableHtml(rows: KeyValueRow[], cx: HtmlRenderContext, path: TreePath): string {
  const trs = rows
    .map((row) => `<tr><th>${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`)
    .join("");
  return `<table class="kv"${pathAttr(cx, path)}><tbody>${trs}</tbody></table>`;
}

function signaturesHtml(places: SignaturePlace[], cx: HtmlRenderContext, path: TreePath): string {
  const cells = places
    .map((place) => {
      const role =
        place.role !== undefined ? `<div class="sig__role">${escapeHtml(place.role)}</div>` : "";
      return `<div class="sig"><div class="sig__line"></div><div class="sig__name">${escapeHtml(place.name)}</div>${role}</div>`;
    })
    .join("");
  return `<div class="signatures"${pathAttr(cx, path)}>${cells}</div>`;
}

function customHtml(node: Extract<DocumentNode, { kind: "custom" }>, cx: HtmlRenderContext, path: TreePath): string {
  const result = dispatchCustomBlock(node, "html", cx);
  // Degradation marker policy (see dispatchCustomBlock): plain body text, escaped as HTML requires.
  if ("marker" in result) {
    return `<div class="legal-doc__unsupported"${pathAttr(cx, path)}>${escapeHtml(result.marker)}</div>`;
  }
  // The block owns its markup (ADR-0006) — trusted consumer code, inserted raw (not escaped). We must
  // not rewrite its root element to add an attribute, so in `emitPaths` mode the block is WRAPPED in a
  // plain addressable div. A `custom` node is opaque to editing but can still be removed or moved, so
  // a UI needs to be able to select it. The wrapper exists only in `emitPaths` mode — exports and the
  // default output keep the block's markup exactly as it was authored.
  return cx.emitPaths ? `<div${pathAttr(cx, path)}>${result.rendered}</div>` : result.rendered;
}
