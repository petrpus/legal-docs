/**
 * The inline redline view: the edited document as it now reads, with what the edit did shown in place.
 *
 * It is a visitor over the one {@link RedlineDoc} the model builds (`core/edit/redline-model.ts`), not a
 * second diff — the DOCX tracked-changes export walks the same structure, so the two can never tell
 * different stories about the same edit. The output is meant to *look like the document*: an untouched
 * block goes through the plain Renderer's own `renderNodeToHtml`, and a changed one is re-emitted with
 * the same tags by the per-kind emitter below, with `<ins>`/`<del>` around the words that moved.
 *
 * Like the review view, this is a second, additional Renderer — never a mode of the first. No exporter
 * routes through it, so a redline cannot leak into a delivered PDF/DOCX/HTML.
 */

import type { Align, BlockIndent, DocumentNode } from "../core/document-tree";
import type {
  RedlineAttr,
  RedlineBlock,
  RedlineDoc,
  RedlineField,
  RedlineListItem,
  RedlineParagraph,
  RedlineRun,
} from "../core/edit/redline-model";
import { formatTreePath, type TreePath } from "../core/edit/tree-path";
import type { InlineSegment } from "../core/text-diff";
import { LegalDocsError } from "../core/errors";
import type { Theme } from "../theme";
import { escapeHtml } from "./escape";
import {
  blockStyle,
  createHtmlRenderContext,
  pathAttr,
  renderNodeToHtml,
  runHtml,
  type HtmlRenderContext,
  type RenderHtmlOptions,
} from "./render-html";
import { themeCss } from "./theme-css";

/**
 * How the redline is laid out. Only `"inline"` exists: insertions and deletions are shown in place,
 * inside one document. `"sideBySide"` — the base and the edited document in two columns — is reserved
 * as a future member of this union, which is why the option exists at all today.
 */
export type RedlineMode = "inline";

/** HTML render options plus what only the redline can answer. `emitPaths` is always on here. */
export interface RenderRedlineOptions extends Omit<RenderHtmlOptions, "emitPaths"> {
  /** Layout. Defaults to `"inline"`, the only mode implemented. */
  mode?: RedlineMode;
}

/**
 * Render a {@link RedlineDoc} as one inline-redline HTML fragment: a `.legal-doc` root (so the Theme's
 * own CSS applies unchanged) also carrying `.legal-redline`, under which every redline rule is scoped.
 * All core-emitted text is escaped, including inside `<ins>`/`<del>`; every block carries its `data-path`
 * in the edited tree, and a deleted block carries `data-base-path` instead — see {@link deletedHtml}.
 */
export function renderRedlineHtml(redline: RedlineDoc, options: RenderRedlineOptions = {}): string {
  const mode = options.mode ?? "inline";
  if (mode !== "inline") {
    throw new LegalDocsError(`unsupported redline mode "${String(mode)}" — only "inline" is implemented (side-by-side is reserved)`);
  }
  const cx = createHtmlRenderContext({ ...options, emitPaths: true });
  const body = redline.blocks.map((block) => blockHtml(block, cx)).join("");
  return (
    `<div class="legal-doc legal-redline legal-redline--${mode}">` +
    `<style>${themeCss(cx.theme)}${redlineCss(cx.theme)}</style>` +
    `${body}${furnitureHtml(redline.furniture, cx)}</div>`
  );
}

function blockHtml(block: RedlineBlock, cx: HtmlRenderContext): string {
  switch (block.status) {
    case "unchanged":
      // Byte for byte what the plain Renderer emits — a redline with no changes is the document.
      return renderNodeToHtml(block.node, cx, block.path);
    case "inserted":
      return marker("ins", renderNodeToHtml(block.node, cx, block.path));
    case "deleted":
      return deletedHtml(block.node, block.path, cx);
    case "attrsChanged":
      return marker("attr", renderNodeToHtml(block.node, cx, block.path), attrNote(block.attrs));
    case "textChanged": {
      const html = changedNodeHtml(block.node, block.path, block.fields, cx);
      return block.attrs.length === 0 ? html : marker("attr", html, attrNote(block.attrs));
    }
    case "container":
      return containerHtml(block.node, block.path, block.fields, block.children, cx);
  }
}

/**
 * A block that the edit removed. Its path is a path in the BASE tree, so it addresses nothing in the
 * document being edited — emitting it as `data-path` would hand a UI a selection target that cannot be
 * resolved. It is emitted as `data-base-path`, and the node is rendered with paths suppressed so its
 * children cannot smuggle stale addresses back in either.
 */
function deletedHtml(node: DocumentNode, basePath: TreePath, cx: HtmlRenderContext): string {
  const inner = renderNodeToHtml(node, { ...cx, emitPaths: false }, basePath);
  return marker("del", inner, "", ` data-base-path="${escapeHtml(formatTreePath(basePath))}"`);
}

/** The wrapper that gives a whole block its verdict. `note` (an attribute change) comes before the block. */
function marker(kind: "ins" | "del" | "attr", inner: string, note = "", attributes = ""): string {
  return `<div class="redline-block redline-block--${kind}"${attributes}>${note}${inner}</div>`;
}

function attrNote(attrs: readonly RedlineAttr[]): string {
  const parts = attrs.map((attr) => `${String(attr.path[attr.path.length - 1])}: ${attrValue(attr.before)} → ${attrValue(attr.after)}`);
  return `<span class="redline-note">${escapeHtml(parts.join("; "))}</span>`;
}

function attrValue(value: Align | BlockIndent | undefined): string {
  if (value === undefined) return "none";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * An article or a list: the node's own markup, with the redline recursing into what it holds. The tags
 * mirror `renderNodeToHtml` exactly — a container whose children all survived is indistinguishable from
 * the plain render.
 */
function containerHtml(
  node: DocumentNode,
  path: TreePath,
  fields: readonly RedlineField[],
  children: Extract<RedlineBlock, { status: "container" }>["children"],
  cx: HtmlRenderContext,
): string {
  switch (node.kind) {
    case "article": {
      const index = indexFields(path, fields);
      // A heading the edit deleted is gone from the node but still has a field, so both are consulted.
      const heading =
        node.heading === undefined && !index.has("heading")
          ? escapeHtml(node.no)
          : `${escapeHtml(node.no)} ${inlineHtml(index, "heading", node.heading)}`;
      const body = children.of === "body" ? children.blocks.map((child) => blockHtml(child, cx)).join("") : "";
      return `<section class="article" data-level="${node.level}"${pathAttr(cx, path)}><div class="article__heading">${heading}</div>${body}</section>`;
    }
    case "numberedList":
    case "bulletList":
    case "alphaList": {
      const tag = node.kind === "bulletList" ? "ul" : "ol";
      const extraClass = node.kind === "alphaList" ? " list--alpha" : "";
      const items = children.of === "items" ? children.items.map((item) => itemHtml(item, cx)).join("") : "";
      return `<${tag} class="list${extraClass}"${pathAttr(cx, path)}>${items}</${tag}>`;
    }
    default:
      throw new LegalDocsError(`a ${node.kind} block holds no children — the redline model never reports it as a container`);
  }
}

/**
 * One list item. An item that was added, dropped or left alone is whole — its nodes take the item's
 * verdict from the `<li>` rather than each carrying their own marker — while a `changed` item is a node
 * list the redline descends into.
 */
function itemHtml(item: RedlineListItem, cx: HtmlRenderContext): string {
  if (item.status === "changed") {
    const blocks = item.blocks.map((block) => blockHtml(block, cx)).join("");
    return `<li class="redline-item redline-item--edit"${pathAttr(cx, item.path)}>${blocks}</li>`;
  }
  if (item.status === "unchanged") {
    const blocks = item.blocks.map((block) => renderNodeToHtml(block.node, cx, block.path)).join("");
    return `<li${pathAttr(cx, item.path)}>${blocks}</li>`;
  }
  const deleted = item.status === "deleted";
  // A deleted item's paths are base-tree paths, exactly as for a deleted block.
  const inner = cx.emitPaths && deleted ? { ...cx, emitPaths: false } : cx;
  const blocks = item.blocks.map((block) => renderNodeToHtml(block.node, inner, block.path)).join("");
  const address = deleted ? ` data-base-path="${escapeHtml(formatTreePath(item.path))}"` : pathAttr(cx, item.path);
  return `<li class="redline-item redline-item--${deleted ? "del" : "ins"}"${address}>${blocks}</li>`;
}

/**
 * The per-kind emitter for a block whose text changed: the same tags `renderNodeToHtml` gives the kind,
 * with each changed leaf replaced by its `<ins>`/`<del>` segments. Exhaustive over the node kinds — a
 * container or a `custom` block never reaches here, because the model reports those as a container or
 * as a deletion plus an insertion, and saying so out loud is what keeps a new kind from slipping past.
 */
function changedNodeHtml(node: DocumentNode, path: TreePath, fields: readonly RedlineField[], cx: HtmlRenderContext): string {
  const index = indexFields(path, fields);
  switch (node.kind) {
    case "title":
      return `<h1 class="title"${blockStyle(node)}${pathAttr(cx, path)}>${inlineHtml(index, "text", node.text)}</h1>`;
    case "paragraph":
      return `<p${blockStyle(node)}${pathAttr(cx, path)}>${inlineHtml(index, "text", node.text)}</p>`;
    case "richText": {
      const field = index.get("value");
      if (field?.kind !== "richText") {
        throw new LegalDocsError("a changed richText block must carry its diffed value — the redline model is inconsistent");
      }
      return `<div class="rich"${pathAttr(cx, path)}>${field.paragraphs.map(paragraphHtml).join("")}</div>`;
    }
    case "partyHeader": {
      const lines = [`<div class="party__name">${inlineHtml(index, "party/name", node.party.name)}</div>`];
      for (const key of ["idNumber", "address"] as const) {
        // An optional line the edit deleted is gone from the node but still has a field to show.
        if (node.party[key] === undefined && !index.has(`party/${key}`)) continue;
        lines.push(`<div>${inlineHtml(index, `party/${key}`, node.party[key])}</div>`);
      }
      return `<div class="party"${pathAttr(cx, path)}><div class="party__role">${inlineHtml(index, "roleLabel", node.roleLabel)}</div>${lines.join("")}</div>`;
    }
    case "keyValueTable": {
      const trs = node.rows
        .map(
          (row, at) =>
            `<tr><th>${inlineHtml(index, `rows/${at}/label`, row.label)}</th><td>${inlineHtml(index, `rows/${at}/value`, row.value)}</td></tr>`,
        )
        .join("");
      return `<table class="kv"${pathAttr(cx, path)}><tbody>${trs}</tbody></table>`;
    }
    case "signatures": {
      const cells = node.places
        .map((place, at) => {
          const roleKey = `places/${at}/role`;
          const role =
            place.role === undefined && !index.has(roleKey)
              ? ""
              : `<div class="sig__role">${inlineHtml(index, roleKey, place.role)}</div>`;
          return `<div class="sig"><div class="sig__line"></div><div class="sig__name">${inlineHtml(index, `places/${at}/name`, place.name)}</div>${role}</div>`;
        })
        .join("");
      return `<div class="signatures"${pathAttr(cx, path)}>${cells}</div>`;
    }
    case "article":
    case "numberedList":
    case "bulletList":
    case "alphaList":
    case "custom":
      throw new LegalDocsError(`a ${node.kind} block is never reported as textChanged — it is a container or opaque`);
    default: {
      const unhandled: never = node;
      throw new LegalDocsError(`Unsupported node kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** A changed leaf keyed by its path relative to the block — `text`, `party/name`, `rows/1/value`. */
type FieldIndex = Map<string, RedlineField>;

function indexFields(path: TreePath, fields: readonly RedlineField[]): FieldIndex {
  return new Map(fields.map((field) => [field.path.slice(path.length).join("/"), field]));
}

/** A leaf's inline HTML: its word-level segments when it changed, otherwise the current text, escaped. */
function inlineHtml(fields: FieldIndex, key: string, current: string | undefined): string {
  const field = fields.get(key);
  if (field === undefined) return escapeHtml(current ?? "");
  if (field.kind !== "text") {
    throw new LegalDocsError(`the ${key} leaf is diffed as rich text, not as a string — the redline model is inconsistent`);
  }
  return field.segments.map(segmentHtml).join("");
}

function segmentHtml(segment: InlineSegment): string {
  const text = escapeHtml(segment.text);
  if (segment.op === "equal") return text;
  return segment.op === "ins" ? `<ins>${text}</ins>` : `<del>${text}</del>`;
}

/** One paragraph of a diffed rich-text value. An unchanged paragraph is the plain Renderer's `<p>`. */
function paragraphHtml(paragraph: RedlineParagraph): string {
  const runs = paragraph.runs.map(runInline).join("");
  if (paragraph.status === "unchanged") return `<p>${runs}</p>`;
  const suffix = paragraph.status === "inserted" ? "ins" : paragraph.status === "deleted" ? "del" : "edit";
  return `<p class="redline-p redline-p--${suffix}">${runs}</p>`;
}

/** A run keeps the marks the model gave it (the after side, except on a deletion) inside its verdict. */
function runInline(run: RedlineRun): string {
  const marked = runHtml(run);
  if (run.op === "equal") return marked;
  return run.op === "ins" ? `<ins>${marked}</ins>` : `<del>${marked}</del>`;
}

/**
 * Changed page-header/footer slots. HTML is a page-less fragment, so furniture is not part of the
 * document render (ADR-0011) — but an edit to it is a real change a reviewer has to see, so it is
 * reported as its own trailing section rather than silently dropped.
 */
function furnitureHtml(fields: readonly RedlineField[], cx: HtmlRenderContext): string {
  if (fields.length === 0) return "";
  const rows = fields
    .map((field) => {
      const inline = field.kind === "text" ? field.segments.map(segmentHtml).join("") : "";
      const slot = escapeHtml(formatTreePath(field.path));
      return `<div class="redline-furniture__row"${pathAttr(cx, field.path)}><span class="redline-furniture__slot">${slot}</span>${inline}</div>`;
    })
    .join("");
  return `<div class="redline-furniture"><div class="redline-furniture__title">Page header and footer</div>${rows}</div>`;
}

function redlineCss(t: Theme): string {
  // Every rule is scoped under `.legal-redline` (the Renderer's scoping invariant), so the Theme's own
  // `.legal-doc` CSS keeps the document looking like the document. Colours match the Clause diff
  // (`clause-diff-html.ts`) so the two diff views in the product read the same way.
  return [
    `.legal-redline ins{background:#e6ffed;text-decoration:none;}`,
    `.legal-redline del{background:#ffeef0;text-decoration:line-through;}`,
    `.legal-redline .redline-block{border-left:3px solid transparent;padding-left:6px;}`,
    `.legal-redline .redline-block--ins{border-left-color:#2da44e;background:#e6ffed;}`,
    `.legal-redline .redline-block--del{border-left-color:#cf222e;background:#ffeef0;text-decoration:line-through;}`,
    `.legal-redline .redline-block--attr{border-left-color:#9a6700;}`,
    `.legal-redline .redline-item--ins{background:#e6ffed;}`,
    `.legal-redline .redline-item--del{background:#ffeef0;text-decoration:line-through;}`,
    `.legal-redline .redline-p--ins{background:#e6ffed;}`,
    `.legal-redline .redline-p--del{background:#ffeef0;text-decoration:line-through;}`,
    `.legal-redline .redline-note{display:block;font-family:sans-serif;font-size:10px;text-transform:uppercase;color:#57606a;}`,
    `.legal-redline .redline-furniture{margin-top:${t.spacing.title}px;border-top:1px solid #d0d7de;padding-top:${t.spacing.paragraph}px;font-family:sans-serif;font-size:${t.footer.fontSize}px;}`,
    `.legal-redline .redline-furniture__title{font-weight:bold;margin-bottom:4px;}`,
    `.legal-redline .redline-furniture__slot{display:inline-block;min-width:120px;color:#57606a;}`,
  ].join("");
}
