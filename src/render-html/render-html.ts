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
import { escapeHtml } from "./escape";
import { themeCss } from "./theme-css";

interface HtmlCtx {
  blocks: CustomBlockRegistry;
  degradation: DegradationMode;
  onDegrade?: OnDegrade;
  theme: Theme;
}

/**
 * The HTML Renderer: a visitor over the DocumentTree, building HTML strings directly (no react-dom).
 * Output is a self-contained `<div class="legal-doc">` fragment with a scoped `<style>`. All
 * core-emitted text is escaped; a Custom block's HTML is trusted and inserted raw.
 */
export function renderTreeToHtml(input: DocumentTree | DocumentBody, options: RenderTreeOptions = {}): string {
  const tree = asDocumentTree(input);
  const theme = mergeTheme(options.theme);
  const cx: HtmlCtx = { blocks: options.customBlocks ?? {}, degradation: options.degradation ?? "placeholder", onDegrade: options.onDegrade, theme };
  // HTML is a page-less fragment, so page header/footer furniture (`tree.header`/`tree.footer`) is
  // intentionally ignored here — it is paged-output-only (PDF/DOCX), like `theme.page.*` (ADR-0011).
  const body = tree.body.map((node) => nodeToHtml(node, cx)).join("");
  return `<div class="legal-doc"><style>${themeCss(theme)}</style>${body}</div>`;
}

function nodeToHtml(node: DocumentNode, cx: HtmlCtx): string {
  switch (node.kind) {
    case "title":
      // Per-block `align`/`indent` override the class default via inline style. Both are guarded at
      // assembly (`align` to the closed enum, `indent` to finite numbers), so they are safe unescaped;
      // `text` is still escaped.
      return `<h1 class="title"${blockStyle(node)}>${escapeHtml(node.text)}</h1>`;
    case "paragraph":
      return `<p${blockStyle(node)}>${escapeHtml(node.text)}</p>`;
    case "richText":
      return richTextHtml(node.value);
    case "article": {
      const heading =
        node.heading === undefined
          ? escapeHtml(node.no)
          : `${escapeHtml(node.no)} ${escapeHtml(node.heading)}`;
      const body = node.body.map((child) => nodeToHtml(child, cx)).join("");
      // `node.level` is a typed number (digits only), so it is safe in the attribute without escaping.
      return `<section class="article" data-level="${node.level}"><div class="article__heading">${heading}</div>${body}</section>`;
    }
    case "numberedList":
      return listHtml(node.items, "ol", "", cx);
    case "bulletList":
      return listHtml(node.items, "ul", "", cx);
    case "alphaList":
      return listHtml(node.items, "ol", " list--alpha", cx);
    case "partyHeader":
      return partyHeaderHtml(node.party, node.roleLabel);
    case "keyValueTable":
      return keyValueTableHtml(node.rows);
    case "signatures":
      return signaturesHtml(node.places);
    case "custom":
      return customHtml(node, cx);
    default: {
      const unhandled: never = node;
      throw new LegalDocsError(`Unsupported node kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Inline `style` for per-block alignment/indent overrides, or "" to fall back to the Theme's class CSS. */
function blockStyle(node: { align?: Align; indent?: BlockIndent }): string {
  const parts: string[] = [];
  if (node.align !== undefined) parts.push(`text-align:${node.align}`);
  if (node.indent?.firstLine !== undefined) parts.push(`text-indent:${node.indent.firstLine}px`);
  if (node.indent?.left !== undefined) parts.push(`margin-left:${node.indent.left}px`);
  return parts.length === 0 ? "" : ` style="${parts.join(";")}"`;
}

function richTextHtml(value: RichTextV1): string {
  const paragraphs = value.blocks
    .map((block) => `<p>${block.runs.map(runHtml).join("")}</p>`)
    .join("");
  return `<div class="rich">${paragraphs}</div>`;
}

function runHtml(run: RichRun): string {
  let text = escapeHtml(run.text);
  if (run.marks?.includes("bold")) text = `<strong>${text}</strong>`;
  if (run.marks?.includes("italic")) text = `<em>${text}</em>`;
  return text;
}

function listHtml(items: DocumentNode[][], tag: "ol" | "ul", extraClass: string, cx: HtmlCtx): string {
  const lis = items
    .map((item) => `<li>${item.map((child) => nodeToHtml(child, cx)).join("")}</li>`)
    .join("");
  return `<${tag} class="list${extraClass}">${lis}</${tag}>`;
}

function partyHeaderHtml(party: PartyIdentification, roleLabel: string): string {
  const lines = [`<div class="party__name">${escapeHtml(party.name)}</div>`];
  if (party.idNumber !== undefined) lines.push(`<div>${escapeHtml(party.idNumber)}</div>`);
  if (party.address !== undefined) lines.push(`<div>${escapeHtml(party.address)}</div>`);
  return `<div class="party"><div class="party__role">${escapeHtml(roleLabel)}</div>${lines.join("")}</div>`;
}

function keyValueTableHtml(rows: KeyValueRow[]): string {
  const trs = rows
    .map((row) => `<tr><th>${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`)
    .join("");
  return `<table class="kv"><tbody>${trs}</tbody></table>`;
}

function signaturesHtml(places: SignaturePlace[]): string {
  const cells = places
    .map((place) => {
      const role =
        place.role !== undefined ? `<div class="sig__role">${escapeHtml(place.role)}</div>` : "";
      return `<div class="sig"><div class="sig__line"></div><div class="sig__name">${escapeHtml(place.name)}</div>${role}</div>`;
    })
    .join("");
  return `<div class="signatures">${cells}</div>`;
}

function customHtml(node: Extract<DocumentNode, { kind: "custom" }>, cx: HtmlCtx): string {
  const result = dispatchCustomBlock(node, "html", cx);
  // Degradation marker policy (see dispatchCustomBlock): plain body text, escaped as HTML requires.
  if ("marker" in result) return `<div class="legal-doc__unsupported">${escapeHtml(result.marker)}</div>`;
  // The block owns its markup (ADR-0006) — trusted consumer code, inserted raw (not escaped).
  return result.rendered;
}
