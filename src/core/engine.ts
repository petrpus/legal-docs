import type { BodyItem, Template } from "./template";
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

/**
 * Tree assembly: evaluate a Template into a renderer-agnostic DocumentTree. Inline text is bound
 * against the payload; `clause:` items are reference-resolved, their vars validated, and their
 * rich text parsed into a `richText` node. Async because resolving Clauses may hit the store.
 */
export async function assembleTree(
  template: Template,
  context: AssembleContext = {},
): Promise<DocumentTree> {
  const evalCtx: EvalContext = {
    scope: context.scope ?? {},
    helpers: { ...defaultHelpers, ...context.helpers },
  };
  const locale = context.locale ?? template.locale;
  return Promise.all(template.body.map((item) => toNode(item, evalCtx, context, locale)));
}

async function toNode(
  item: BodyItem,
  evalCtx: EvalContext,
  context: AssembleContext,
  locale: string,
): Promise<DocumentNode> {
  if ("title" in item) return { kind: "title", text: interpolate(item.title, evalCtx) };
  if ("paragraph" in item) return { kind: "paragraph", text: interpolate(item.paragraph, evalCtx) };
  if ("clause" in item) return clauseNode(item, evalCtx, context, locale);
  throw new Error(`Unsupported body item: ${JSON.stringify(item)}`);
}

async function clauseNode(
  item: { clause: string; vars?: Record<string, unknown> },
  evalCtx: EvalContext,
  context: AssembleContext,
  locale: string,
): Promise<DocumentNode> {
  if (!context.clauses) {
    throw new Error(`No clause resolver available to render "${item.clause}"`);
  }
  const clause = await context.clauses(item.clause, locale);
  const bound = bindVars(item.vars ?? {}, evalCtx);
  const validated = validateVars(clause.vars, bound);
  // Interpolation runs before parsing, so a var value is substituted as raw text: it is NOT
  // markdown-escaped, and a value containing `*`/`**` would become a mark. Fine for the typed vars
  // here; revisit if untrusted string vars are introduced.
  const text = interpolate(clause.text, { scope: validated, helpers: evalCtx.helpers });
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
