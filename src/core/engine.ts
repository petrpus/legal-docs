import type { ArticleItem, BodyItem, Template } from "./template";
import type { DocumentNode, DocumentTree } from "./document-tree";
import type { Clause } from "./clause";
import { evaluate, type EvalContext } from "./expression";
import { interpolate } from "./interpolate";
import { parseRichText } from "./rich-text";
import { validateVars } from "./vars-schema";
import { defaultHelpers, type HelperRegistry } from "./helpers";

/** Resolves a Clause reference (`id@vN` | `id@latest`) to a concrete Clause for a locale. */
export type ClauseResolver = (ref: string, locale: string) => Promise<Clause>;

export interface AssembleContext {
  /** The (validated) payload that `$paths` bind against. */
  scope?: Record<string, unknown>;
  /** Extra helpers, merged over the defaults. */
  helpers?: HelperRegistry;
  /** Resolves Clause references; required if the template uses `clause:` items. */
  clauses?: ClauseResolver;
  /** Locale used to resolve Clauses (defaults to the template's locale). */
  locale?: string;
}

interface Frame {
  evalCtx: EvalContext;
  context: AssembleContext;
  locale: string;
}

/** Articles deeper than this share the deepest level's styling. */
export const MAX_LEVEL = 3;

/**
 * Tree assembly: evaluate a Template into a renderer-agnostic DocumentTree. Inline text is bound
 * against the payload; `clause:` items are reference-resolved and validated; `article:` and list
 * items assemble their bodies recursively. Async because resolving Clauses may hit the store.
 */
export async function assembleTree(
  template: Template,
  context: AssembleContext = {},
): Promise<DocumentTree> {
  const frame: Frame = {
    evalCtx: { scope: context.scope ?? {}, helpers: { ...defaultHelpers, ...context.helpers } },
    context,
    locale: context.locale ?? template.locale,
  };
  return assembleItems(template.body, frame, 1);
}

function assembleItems(items: BodyItem[], frame: Frame, level: number): Promise<DocumentNode[]> {
  return Promise.all(items.map((item) => toNode(item, frame, level)));
}

async function toNode(item: BodyItem, frame: Frame, level: number): Promise<DocumentNode> {
  if ("title" in item) return { kind: "title", text: interpolate(item.title, frame.evalCtx) };
  if ("paragraph" in item) {
    return { kind: "paragraph", text: interpolate(item.paragraph, frame.evalCtx) };
  }
  if ("clause" in item) return clauseNode(item, frame);
  if ("article" in item) return articleNode(item.article, frame, level);
  if ("numberedList" in item) {
    return { kind: "numberedList", items: await assembleListItems(item.numberedList, frame, level) };
  }
  if ("bulletList" in item) {
    return { kind: "bulletList", items: await assembleListItems(item.bulletList, frame, level) };
  }
  if ("alphaList" in item) {
    return { kind: "alphaList", items: await assembleListItems(item.alphaList, frame, level) };
  }
  throw new Error(`Unsupported body item: ${JSON.stringify(item)}`);
}

async function articleNode(article: ArticleItem, frame: Frame, level: number): Promise<DocumentNode> {
  const body = await assembleItems(article.body, frame, Math.min(level + 1, MAX_LEVEL));
  return {
    kind: "article",
    no: article.no,
    level: Math.min(level, MAX_LEVEL),
    ...(article.heading !== undefined
      ? { heading: interpolate(article.heading, frame.evalCtx) }
      : {}),
    body,
  };
}

function assembleListItems(
  items: BodyItem[][],
  frame: Frame,
  level: number,
): Promise<DocumentNode[][]> {
  return Promise.all(items.map((item) => assembleItems(item, frame, level)));
}

async function clauseNode(
  item: { clause: string; vars?: Record<string, unknown> },
  frame: Frame,
): Promise<DocumentNode> {
  if (!frame.context.clauses) {
    throw new Error(`No clause resolver available to render "${item.clause}"`);
  }
  const clause = await frame.context.clauses(item.clause, frame.locale);
  const bound = bindVars(item.vars ?? {}, frame.evalCtx);
  const validated = validateVars(clause.vars, bound);
  // Interpolation runs before parsing, so a var value is substituted as raw text: it is NOT
  // markdown-escaped, and a value containing `*`/`**` would become a mark. Fine for the typed vars
  // here; revisit if untrusted string vars are introduced.
  const text = interpolate(clause.text, { scope: validated, helpers: frame.evalCtx.helpers });
  return { kind: "richText", value: parseRichText(text) };
}

/** Map a template's `vars` entries into values: `$`-strings are evaluated, everything else is literal. */
function bindVars(
  mapping: Record<string, unknown>,
  evalCtx: EvalContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mapping)) {
    // A `$`-prefixed string is an expression over the payload; everything else is a literal. So a
    // literal value that genuinely starts with `$` (e.g. "$100") cannot be passed this way.
    out[name] = typeof value === "string" && value.startsWith("$") ? evaluate(value, evalCtx) : value;
  }
  return out;
}
