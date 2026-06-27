import { evaluate, type EvalContext } from "./expression";

const TOKEN = /\{\{([^}]+)\}\}/g;

/**
 * Replace `{{ expr }}` tokens in a string with their evaluated values. Text without tokens is
 * returned unchanged, so document-specific literal text needs no payload.
 */
export function interpolate(text: string, ctx: EvalContext): string {
  if (!text.includes("{{")) return text;
  return text.replace(TOKEN, (_match, expr: string) => stringify(evaluate(expr.trim(), ctx)));
}

function stringify(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Extract the inner expressions of all `{{ }}` tokens in a string (for integrity-lint). */
export function expressionTokens(text: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    const inner = match[1];
    if (inner !== undefined) out.push(inner.trim());
  }
  return out;
}
