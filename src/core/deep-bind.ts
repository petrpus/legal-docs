import { evaluate, type EvalContext } from "./expression";

/**
 * Recursively bind a value against the payload: every `$`-prefixed string leaf is evaluated as an
 * expression, and everything else passes through unchanged, descending into arrays and plain objects.
 * Used to bind a Custom block's `props` (ADR-0005) — assembling an object of `$`-paths is Binding,
 * not computation, so anything *computed* must still come from a Derivation.
 *
 * Footgun (as with `vars` binding): a literal string that genuinely starts with `$` (e.g. "$100")
 * cannot be expressed this way — it would be treated as an expression.
 */
export function deepBind(value: unknown, evalCtx: EvalContext): unknown {
  if (typeof value === "string") {
    return value.startsWith("$") ? evaluate(value, evalCtx) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepBind(item, evalCtx));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepBind(item, evalCtx);
    return out;
  }
  return value;
}

/**
 * Only plain objects and arrays are descended. Exotic objects (Date, Map, class instances) pass
 * through untouched rather than being shallow-flattened — props must still be JSON-serializable for
 * the Snapshot, which is the author's responsibility.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}
