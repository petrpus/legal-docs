import type {
  DocumentNode,
  DocumentTree,
  KeyValueRow,
  PartyIdentification,
  SignaturePlace,
} from "../core/document-tree";
import type { RichRun, RichTextV1 } from "../core/rich-text";
import { validatePayload } from "../core/payload";
import { defaultTheme, type Theme } from "../render-pdf/theme";
import type { CustomBlockRegistry, DegradationMode } from "../render-pdf/custom-block";
import { escapeHtml } from "./escape";
import { themeCss } from "./theme-css";

interface HtmlCtx {
  blocks: CustomBlockRegistry;
  degradation: DegradationMode;
  theme: Theme;
}

/**
 * The HTML Renderer: a visitor over the DocumentTree, building HTML strings directly (no react-dom).
 * Output is a self-contained `<div class="legal-doc">` fragment with a scoped `<style>`. All
 * core-emitted text is escaped; a Custom block's HTML is trusted and inserted raw.
 */
export function renderTreeToHtml(
  tree: DocumentTree,
  theme: Theme = defaultTheme,
  customBlocks: CustomBlockRegistry = {},
  degradation: DegradationMode = "placeholder",
): string {
  const cx: HtmlCtx = { blocks: customBlocks, degradation, theme };
  const body = tree.map((node) => nodeToHtml(node, cx)).join("");
  return `<div class="legal-doc"><style>${themeCss(theme)}</style>${body}</div>`;
}

function nodeToHtml(node: DocumentNode, cx: HtmlCtx): string {
  switch (node.kind) {
    case "title":
      return `<h1 class="title">${escapeHtml(node.text)}</h1>`;
    case "paragraph":
      return `<p>${escapeHtml(node.text)}</p>`;
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
      throw new Error(`Unsupported node kind: ${JSON.stringify(unhandled)}`);
    }
  }
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
  const block = cx.blocks[node.component];
  if (!block) throw new Error(`Custom block "${node.component}" is not registered`);
  if (typeof block.html !== "function") return degradeHtml(node.component, cx.degradation);
  let props = node.props;
  if (block.schema) {
    try {
      props = validatePayload(block.schema, node.props);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Custom block "${node.component}" received invalid props: ${reason}`, { cause });
    }
  }
  // The block owns its markup (ADR-0006) — trusted consumer code, inserted raw (not escaped).
  return block.html(props, { theme: cx.theme });
}

/** Degradation contract for HTML: a visible, logged placeholder, or a hard failure — never silent. */
function degradeHtml(component: string, mode: DegradationMode): string {
  if (mode === "throw") {
    throw new Error(
      `Custom block "${component}" cannot render in "html": no html implementation (degradation=throw)`,
    );
  }
  const marker = `[unsupported block: ${component} in html]`;
  console.warn(marker);
  return `<div class="legal-doc__unsupported">${escapeHtml(marker)}</div>`;
}
