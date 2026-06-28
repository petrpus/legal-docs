import type { BodyItem, Include, KeyValueRows, Template } from "../core/template";
import type { Clause } from "../core/clause";
import type { VarSpec } from "../core/vars-schema";
import { defaultHelpers, type HelperRegistry } from "../core/helpers";
import type { DerivationRegistry } from "../core/resolve";
import { helperCallsIn } from "../core/expression";
import { expressionTokens } from "../core/interpolate";
import { expandIncludes, IncludeError } from "../core/includes";

export interface ValidationFinding {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  findings: ValidationFinding[];
}

export interface ValidateOptions {
  /** Extra helpers beyond the defaults (so lint knows what is registered). */
  helpers?: HelperRegistry;
  /** Derivations available by name. */
  derivations?: DerivationRegistry;
}

/** Minimal Catalog surface the lint needs (avoids a Catalog ↔ validate import cycle). */
export interface LintableCatalog {
  templateIds(): Promise<string[]>;
  getTemplate(id: string): Promise<Template>;
  getClause(ref: string, locale: string): Promise<Clause>;
  loadInclude(id: string): Promise<Include>;
}

interface LintContext {
  catalog: LintableCatalog;
  locale: string;
  helpers: Set<string>;
  derivations: Set<string>;
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

  for (const id of await catalog.templateIds()) {
    const template = await catalog.getTemplate(id);
    const base = `templates/${id}`;
    if (template.template !== id) {
      findings.push({
        path: base,
        message: `template id "${template.template}" does not match its file name "${id}"`,
      });
    }
    for (const name of template.derivations ?? []) {
      if (!derivations.has(name)) {
        findings.push({ path: `${base} › derivations`, message: `derivation "${name}" is not registered` });
      }
    }
    const ctx: LintContext = { catalog, locale: template.locale, helpers, derivations, findings };
    // Lint the include-expanded body so Clauses/helpers inside Includes are checked too. A bad
    // include is itself a finding; the unexpanded body is linted as a fallback. Note: expansion is
    // fail-fast, so a template with several bad includes surfaces only the first — re-run after
    // fixing it. (Findings across different templates and other rule kinds are still collected.)
    let body = template.body;
    try {
      body = await expandIncludes(template.body, (id) => catalog.loadInclude(id));
    } catch (error) {
      if (!(error instanceof IncludeError)) throw error;
      findings.push({ path: `${base} › ${error.path}`, message: error.message });
    }
    await lintItems(body, `${base} › body`, ctx);
  }

  return { ok: findings.length === 0, findings };
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
  // `include` is resolved by expansion before lintItems runs; an unresolved one is already a finding.
  if ("include" in item) return;
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
