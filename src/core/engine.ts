import type { ArticleItem, BodyItem, KeyValueRows, SignaturePlaceSpec, Template } from "./template";
import type { DocumentNode, DocumentTree, KeyValueRow, SignaturePlace } from "./document-tree";
import type { Clause } from "./clause";
import { evaluate, type EvalContext } from "./expression";
import { interpolate } from "./interpolate";
import { parseRichText } from "./rich-text";
import { validateVars } from "./vars-schema";
import { validatePayload } from "./payload";
import { party } from "./schema-fragments";
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
  if ("partyHeader" in item) return partyHeaderNode(item.partyHeader, frame);
  if ("keyValueTable" in item) return keyValueTableNode(item.keyValueTable, frame);
  if ("signatures" in item) return signaturesNode(item.signatures, frame);
  throw new Error(`Unsupported body item: ${JSON.stringify(item)}`);
}

function signaturesNode(spec: { places: SignaturePlaceSpec[] }, frame: Frame): DocumentNode {
  return { kind: "signatures", places: spec.places.map((place) => toPlace(place, frame.evalCtx)) };
}

function toPlace(spec: SignaturePlaceSpec, evalCtx: EvalContext): SignaturePlace {
  if (spec.party !== undefined && spec.name !== undefined) {
    throw new Error("signatures: a place has both `party` and `name`; use exactly one");
  }
  let name: string;
  if (spec.party !== undefined) {
    const resolved = evaluate(spec.party, evalCtx);
    name = validatePayload(party, resolved).name;
  } else if (spec.name !== undefined) {
    name = interpolate(spec.name, evalCtx);
  } else {
    throw new Error("signatures: a place needs either `party` or `name`");
  }
  return { name, ...(spec.role !== undefined ? { role: interpolate(spec.role, evalCtx) } : {}) };
}

function partyHeaderNode(
  spec: { party: string; roleLabel: string },
  frame: Frame,
): DocumentNode {
  const resolved = evaluate(spec.party, frame.evalCtx);
  if (resolved === undefined || resolved === null) {
    throw new Error(`partyHeader: "${spec.party}" resolved to no party`);
  }
  const identification = validatePayload(party, resolved);
  return {
    kind: "partyHeader",
    party: identification,
    roleLabel: interpolate(spec.roleLabel, frame.evalCtx),
  };
}

function keyValueTableNode(spec: { rows: KeyValueRows }, frame: Frame): DocumentNode {
  return { kind: "keyValueTable", rows: buildRows(spec.rows, frame.evalCtx) };
}

function buildRows(rows: KeyValueRows, evalCtx: EvalContext): KeyValueRow[] {
  if (Array.isArray(rows)) {
    return rows.map((row) => ({
      label: interpolate(row.label, evalCtx),
      value: interpolate(row.value, evalCtx),
    }));
  }
  const builder = evalCtx.helpers[rows.fn];
  if (!builder) throw new Error(`Unknown row-builder helper: ${rows.fn}`);
  const args = (rows.args ?? []).map((arg) =>
    typeof arg === "string" && arg.startsWith("$") ? evaluate(arg, evalCtx) : arg,
  );
  let produced: unknown;
  try {
    produced = builder(...args);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Row-builder "${rows.fn}" failed: ${reason}`, { cause });
  }
  return asKeyValueRows(produced, rows.fn);
}

function asKeyValueRows(value: unknown, fn: string): KeyValueRow[] {
  if (!Array.isArray(value)) {
    throw new Error(`Row-builder "${fn}" must return an array of { label, value }`);
  }
  return value.map((row, i) => {
    if (row === null || typeof row !== "object") {
      throw new Error(`Row-builder "${fn}" returned a non-object row at index ${i}`);
    }
    const r = row as Record<string, unknown>;
    return { label: cell(r.label, fn, i, "label"), value: cell(r.value, fn, i, "value") };
  });
}

function cell(value: unknown, fn: string, index: number, key: "label" | "value"): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  throw new Error(`Row-builder "${fn}" row ${index}: "${key}" must be a string or number`);
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
