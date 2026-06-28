import type { ZodType } from "zod";
import type { BodyItem, Include, KeyValueRows, Template } from "../core/template";
import type { Clause } from "../core/clause";
import type { VarSpec } from "../core/vars-schema";
import { defaultHelpers, type HelperRegistry } from "../core/helpers";
import type { DerivationRegistry } from "../core/resolve";
import { helperCallsIn } from "../core/expression";
import { expressionTokens } from "../core/interpolate";
import { expandIncludes, IncludeError } from "../core/includes";
import { CompositionError } from "../core/compose";

export interface ValidationFinding {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  findings: ValidationFinding[];
}

/** Lint-facing view of a Custom block: only its props `schema` matters here, not its render impls. */
export type LintCustomBlocks = Record<string, { schema?: ZodType }>;

export interface ValidateOptions {
  /** Extra helpers beyond the defaults (so lint knows what is registered). */
  helpers?: HelperRegistry;
  /** Derivations available by name. */
  derivations?: DerivationRegistry;
  /** Custom blocks available by `component` name (so lint can check registration + literal props). */
  customBlocks?: LintCustomBlocks;
}

/** Minimal Catalog surface the lint needs (avoids a Catalog ↔ validate import cycle). */
export interface LintableCatalog {
  templateIds(): Promise<string[]>;
  getTemplate(id: string, variant?: string): Promise<Template>;
  getClause(ref: string, locale: string): Promise<Clause>;
  loadInclude(id: string): Promise<Include>;
  familyIds(): Promise<string[]>;
  variantIds(family: string): Promise<string[]>;
}

interface LintContext {
  catalog: LintableCatalog;
  locale: string;
  helpers: Set<string>;
  derivations: Set<string>;
  customBlocks: LintCustomBlocks;
  findings: ValidationFinding[];
}

/**
 * Integrity lint: every literal Clause reference resolves, every helper / derivation used is
 * registered, and clause `vars` mappings match the clause mini-schema (presence + literal types).
 * Returns path-precise findings rather than throwing, so callers can report all problems at once.
 */
export async function validateCatalog(
  catalog: LintableCatalog,
  options: ValidateOptions = {},
): Promise<ValidationResult> {
  const findings: ValidationFinding[] = [];
  const helpers = new Set(Object.keys({ ...defaultHelpers, ...options.helpers }));
  const derivations = new Set(Object.keys(options.derivations ?? {}));

  const base = { helpers, derivations, customBlocks: options.customBlocks ?? {}, findings };

  for (const id of await catalog.templateIds()) {
    const template = await catalog.getTemplate(id);
    const path = `templates/${id}`;
    if (template.template !== id) {
      findings.push({
        path,
        message: `template id "${template.template}" does not match its file name "${id}"`,
      });
    }
    lintDerivations(template, path, derivations, findings);
    await lintBody(template, path, { catalog, locale: template.locale, ...base });
  }

  for (const family of await catalog.familyIds()) {
    for (const variant of await catalog.variantIds(family)) {
      const path = `templates/${family} › ${variant}`;
      let template: Template;
      try {
        // Composition surfaces undeclared-slot overrides and `extends` mismatches as a thrown error.
        template = await catalog.getTemplate(family, variant);
      } catch (error) {
        if (!(error instanceof CompositionError)) throw error;
        findings.push({ path, message: error.message });
        continue;
      }
      lintDerivations(template, path, derivations, findings);
      await lintBody(template, path, { catalog, locale: template.locale, ...base });
    }
  }

  return { ok: findings.length === 0, findings };
}

function lintDerivations(
  template: Template,
  path: string,
  derivations: Set<string>,
  findings: ValidationFinding[],
): void {
  for (const name of template.derivations ?? []) {
    if (!derivations.has(name)) {
      findings.push({ path: `${path} › derivations`, message: `derivation "${name}" is not registered` });
    }
  }
}

/**
 * Lint a Template's body, expanded for Includes so Clauses/helpers inside an Include are checked too.
 * A bad include is itself a finding; the unexpanded body is linted as a fallback. Expansion is
 * fail-fast, so several bad includes in one body surface only the first — re-run after fixing it.
 */
async function lintBody(template: Template, path: string, ctx: LintContext): Promise<void> {
  let body = template.body;
  try {
    body = await expandIncludes(template.body, (id) => ctx.catalog.loadInclude(id));
  } catch (error) {
    if (!(error instanceof IncludeError)) throw error;
    ctx.findings.push({ path: `${path} › ${error.path}`, message: error.message });
  }
  await lintItems(body, `${path} › body`, ctx);
}

async function lintItems(items: BodyItem[], path: string, ctx: LintContext): Promise<void> {
  for (const [i, item] of items.entries()) {
    await lintItem(item, `${path}[${i}]`, ctx);
  }
}

async function lintItem(item: BodyItem, path: string, ctx: LintContext): Promise<void> {
  if ("title" in item) return checkString(item.title, path, ctx);
  if ("paragraph" in item) return checkString(item.paragraph, path, ctx);
  if ("clause" in item) return lintClause(item, path, ctx);
  if ("article" in item) {
    if (item.article.heading !== undefined) checkString(item.article.heading, path, ctx);
    return lintItems(item.article.body, `${path} › article`, ctx);
  }
  if ("numberedList" in item) return lintListItems(item.numberedList, path, ctx);
  if ("bulletList" in item) return lintListItems(item.bulletList, path, ctx);
  if ("alphaList" in item) return lintListItems(item.alphaList, path, ctx);
  if ("partyHeader" in item) return checkString(item.partyHeader.roleLabel, path, ctx);
  if ("keyValueTable" in item) return lintRows(item.keyValueTable.rows, path, ctx);
  if ("signatures" in item) {
    for (const place of item.signatures.places) {
      if (place.name !== undefined) checkString(place.name, path, ctx);
      if (place.role !== undefined) checkString(place.role, path, ctx);
    }
    return;
  }
  if ("if" in item) {
    await lintItems(item.then, `${path} › then`, ctx);
    if (item.else) await lintItems(item.else, `${path} › else`, ctx);
    return;
  }
  if ("for" in item) return lintItems(item.body, `${path} › for`, ctx);
  if ("custom" in item) return lintCustom(item.custom, path, ctx);
  // `include` is resolved by expansion before lintItems runs; an unresolved one is already a finding.
  if ("include" in item) return;
  // A Slot is filled by composition before a Variant body reaches the lint, so any surviving `{ slot }`
  // is misplaced — declared inside an Include or an override fill, or used in a standalone Template,
  // none of which composition can reach. It would fail hard at render, so flag it here.
  if ("slot" in item) {
    ctx.findings.push({
      path,
      message: `unfilled slot "${item.slot}": a Slot must be declared directly in a Base template body`,
    });
    return;
  }
}

async function lintListItems(groups: BodyItem[][], path: string, ctx: LintContext): Promise<void> {
  for (const [i, group] of groups.entries()) {
    await lintItems(group, `${path}[${i}]`, ctx);
  }
}

function lintRows(rows: KeyValueRows, path: string, ctx: LintContext): void {
  if (Array.isArray(rows)) {
    for (const row of rows) {
      checkString(row.label, path, ctx);
      checkString(row.value, path, ctx);
    }
    return;
  }
  if (!ctx.helpers.has(rows.fn)) {
    ctx.findings.push({ path, message: `row-builder helper "${rows.fn}" is not registered` });
  }
  // `$`-expression args are evaluated at render and may themselves call helpers.
  for (const arg of rows.args ?? []) {
    if (typeof arg === "string" && arg.startsWith("$")) checkExpression(arg, path, ctx);
  }
}

async function lintClause(
  item: { clause: string; vars?: Record<string, unknown> },
  path: string,
  ctx: LintContext,
): Promise<void> {
  // A `$`-expression ref is chosen at render time and cannot be resolved statically.
  if (item.clause.startsWith("$")) return;

  let clause: Clause;
  try {
    clause = await ctx.catalog.getClause(item.clause, ctx.locale);
  } catch {
    ctx.findings.push({ path, message: `clause "${item.clause}" does not resolve` });
    return;
  }
  lintVars(clause, item.vars ?? {}, path, ctx);
}

function lintVars(
  clause: Clause,
  vars: Record<string, unknown>,
  path: string,
  ctx: LintContext,
): void {
  for (const [name, spec] of Object.entries(clause.vars)) {
    if (!spec.optional && !(name in vars)) {
      ctx.findings.push({ path, message: `clause "${clause.clause}" requires var "${name}"` });
    }
  }
  for (const [name, value] of Object.entries(vars)) {
    const spec = clause.vars[name];
    if (!spec) {
      ctx.findings.push({ path, message: `clause "${clause.clause}" has no var "${name}"` });
      continue;
    }
    if (value === null || value === undefined) {
      if (!spec.optional) {
        ctx.findings.push({ path, message: `clause "${clause.clause}" requires var "${name}"` });
      }
      continue;
    }
    // Only a literal (non-`$`-expression) value can be statically typechecked.
    if (typeof value === "string" && value.startsWith("$")) continue;
    const mismatch = literalVarMismatch(spec, value);
    if (mismatch) {
      ctx.findings.push({ path, message: `clause "${clause.clause}" var "${name}": ${mismatch}` });
    }
  }
}

function literalVarMismatch(spec: VarSpec, value: unknown): string | null {
  switch (spec.type) {
    case "string":
      return typeof value === "string" ? null : "expected a string";
    case "boolean":
      return typeof value === "boolean" ? null : "expected a boolean";
    case "number":
    case "integer":
      if (typeof value !== "number") return `expected a ${spec.type}`;
      if (spec.type === "integer" && !Number.isInteger(value)) return "expected an integer";
      return null;
    default: {
      const unknownType: string = spec.type;
      return `unknown var type "${unknownType}"`;
    }
  }
}

function lintCustom(
  spec: { component: string; props?: unknown },
  path: string,
  ctx: LintContext,
): void {
  const block = ctx.customBlocks[spec.component];
  if (!block) {
    ctx.findings.push({ path, message: `custom block "${spec.component}" is not registered` });
    return;
  }
  // Only fully-literal props are checked: a closed zod schema cannot be partially validated against a
  // props object with some `$`-expression leaves (resolved at render) without losing required-field
  // checks, so mixed literal+expression props are intentionally skipped wholesale (re-checked at render).
  if (spec.props === undefined || !block.schema || hasExpression(spec.props)) return;
  const result = block.schema.safeParse(spec.props);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join(".");
    const detail = issue ? `${where ? `props.${where}` : "props"}: ${issue.message}` : "invalid props";
    ctx.findings.push({ path, message: `custom block "${spec.component}" ${detail}` });
  }
}

/**
 * True if any string leaf is a `$`-expression — meaning the value is bound at render, not literal.
 * Descends only into arrays and plain objects, matching `deepBind`'s descent rule (exotic objects are
 * passed through there, so a `$`-string inside one would not be evaluated and must not be detected here).
 */
function hasExpression(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith("$");
  if (Array.isArray(value)) return value.some(hasExpression);
  if (isPlainObject(value)) return Object.values(value).some(hasExpression);
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function checkString(text: string, path: string, ctx: LintContext): void {
  for (const expr of expressionTokens(text)) checkExpression(expr, path, ctx);
}

function checkExpression(expr: string, path: string, ctx: LintContext): void {
  for (const name of helperCallsIn(expr)) {
    if (!ctx.helpers.has(name)) {
      ctx.findings.push({ path, message: `helper "${name}" is not registered` });
    }
  }
}
