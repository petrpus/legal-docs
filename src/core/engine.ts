import type { ArticleItem, BodyItem, KeyValueRows, SignaturePlaceSpec, Template, TextSpec } from "./template";
import type { BlockIndent, DocumentNode, DocumentTree, KeyValueRow, SignaturePlace } from "./document-tree";
import { ALIGN_VALUES, isAlign } from "./document-tree";
import type { Clause } from "./clause";
import { evaluate, evaluatePath, evaluatePredicate, type EvalContext } from "./expression";
import { deepBind } from "./deep-bind";
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

async function assembleItems(items: BodyItem[], frame: Frame, level: number): Promise<DocumentNode[]> {
  const groups = await Promise.all(items.map((item) => expandItem(item, frame, level)));
  return groups.flat();
}

/** Expand one body item into zero or more nodes. Control structures (`if`/`for`) expand variably. */
async function expandItem(item: BodyItem, frame: Frame, level: number): Promise<DocumentNode[]> {
  if ("if" in item) return assembleIf(item, frame, level);
  if ("for" in item) return assembleFor(item, frame, level);
  return [await toNode(item, frame, level)];
}

async function assembleIf(
  item: { if: string; then: BodyItem[]; else?: BodyItem[] },
  frame: Frame,
  level: number,
): Promise<DocumentNode[]> {
  const branch = evaluatePredicate(item.if, frame.evalCtx) ? item.then : (item.else ?? []);
  return assembleItems(branch, frame, level);
}

async function assembleFor(
  item: { for: { each: string; as: string }; body: BodyItem[] },
  frame: Frame,
  level: number,
): Promise<DocumentNode[]> {
  const list = evaluatePath(item.for.each, frame.evalCtx);
  if (!Array.isArray(list)) {
    throw new Error(`for: "${item.for.each}" did not resolve to an array`);
  }
  const groups: DocumentNode[][] = [];
  for (let index = 0; index < list.length; index++) {
    // `index` is reserved as the loop counter ($index); a loop var named "index" would collide.
    const scope = { ...frame.evalCtx.scope, [item.for.as]: list[index], index };
    const childFrame: Frame = { ...frame, evalCtx: { ...frame.evalCtx, scope } };
    groups.push(await assembleItems(item.body, childFrame, level));
  }
  return groups.flat();
}

async function toNode(item: BodyItem, frame: Frame, level: number): Promise<DocumentNode> {
  if ("title" in item) return textNode("title", item.title, frame);
  if ("paragraph" in item) return textNode("paragraph", item.paragraph, frame);
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
  if ("custom" in item) return customNode(item.custom, frame);
  if ("slot" in item) {
    throw new Error(`Unfilled slot "${item.slot}" reached tree assembly — compose a Variant first`);
  }
  throw new Error(`Unsupported body item: ${JSON.stringify(item)}`);
}

/**
 * Normalize a `title`/`paragraph` body item (string shorthand or `TextSpec` object) into its node.
 * The `text` is interpolated; an authored `align` override is carried onto the node. When no override
 * is given the node omits `align` (identical to the pre-styling shape), so the renderer applies the
 * Theme default and existing snapshots/golden output are unchanged (ADR-0008).
 */
function textNode(kind: "title" | "paragraph", spec: string | TextSpec, frame: Frame): DocumentNode {
  const text = interpolate(typeof spec === "string" ? spec : spec.text, frame.evalCtx);
  if (typeof spec === "string") return { kind, text };
  // The body is authored YAML (cast, not zod-validated), so guard the styling here — the single choke
  // point every template flows through. This makes `align`/`indent` well-formed for every renderer.
  const { align } = spec;
  if (align !== undefined && !isAlign(align)) {
    throw new Error(`Invalid ${kind} align "${String(align)}"; expected one of ${ALIGN_VALUES.join(", ")}`);
  }
  const indent = buildIndent(kind, spec);
  return {
    kind,
    text,
    ...(align !== undefined ? { align } : {}),
    ...(indent !== undefined ? { indent } : {}),
  };
}

/** Map the authoring `indent`/`firstLineIndent` (points) onto the node's `{ firstLine, left }`, or undefined. */
function buildIndent(kind: string, spec: TextSpec): BlockIndent | undefined {
  const num = (value: unknown, name: string): number | undefined => {
    if (value === undefined) return undefined;
    // v1 is non-negative only; negative (hanging/outdent) is a deferred feature (ADR-0008) — rejecting
    // it here keeps all three renderers consistent (they'd otherwise diverge on a negative value).
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid ${kind} ${name} "${String(value)}"; expected a non-negative number (design points)`);
    }
    return value;
  };
  const firstLine = num(spec.firstLineIndent, "firstLineIndent");
  const left = num(spec.indent, "indent");
  if (firstLine === undefined && left === undefined) return undefined;
  return {
    ...(firstLine !== undefined ? { firstLine } : {}),
    ...(left !== undefined ? { left } : {}),
  };
}

/** Build a Custom block node, deep-binding its props. The engine never touches the (code-side) registry. */
function customNode(spec: { component: string; props?: unknown }, frame: Frame): DocumentNode {
  return {
    kind: "custom",
    component: spec.component,
    props: spec.props === undefined ? undefined : deepBind(spec.props, frame.evalCtx),
  };
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
  // The ref may be a `$`-expression (e.g. a Derivation choosing the version) or a literal.
  const ref = item.clause.startsWith("$")
    ? String(evaluate(item.clause, frame.evalCtx))
    : item.clause;
  const clause = await frame.context.clauses(ref, frame.locale);
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
