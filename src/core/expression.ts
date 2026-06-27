import jsep from "jsep";
import type { HelperRegistry } from "./helpers";

/**
 * A small, safe expression evaluator. Parsing is delegated to jsep; this module controls the
 * semantics and the security boundary: only `$`-rooted payload paths, literals, comparison/logical/
 * arithmetic operators, a ternary, and calls to whitelisted helpers are allowed. No assignment, no
 * member-method calls, no arbitrary identifiers — so a non-developer author cannot inject code.
 */
export type Scope = Record<string, unknown>;

export interface EvalContext {
  scope: Scope;
  helpers: HelperRegistry;
}

export class ExpressionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExpressionError";
  }
}

export function evaluate(expr: string, ctx: EvalContext): unknown {
  let ast: jsep.Expression;
  try {
    ast = jsep(expr);
  } catch (cause) {
    throw new ExpressionError(`Cannot parse expression: ${expr}`, { cause });
  }
  return evalNode(ast, ctx);
}

function evalNode(node: jsep.Expression, ctx: EvalContext): unknown {
  // jsep's runtime nodes match its own discriminated union; bridge its loose return type to it.
  const n = node as jsep.CoreExpression;
  switch (n.type) {
    case "Literal":
      return n.value;
    case "Identifier":
      return resolveIdentifier(n.name, ctx.scope);
    case "MemberExpression": {
      const object = evalNode(n.object, ctx);
      const key = n.computed ? evalNode(n.property, ctx) : identifierName(n.property);
      return member(object, key, n.optional === true);
    }
    case "UnaryExpression":
      return applyUnary(n.operator, evalNode(n.argument, ctx));
    case "BinaryExpression":
      return applyBinary(n.operator, n.left, n.right, ctx);
    case "ConditionalExpression":
      return evalNode(n.test, ctx)
        ? evalNode(n.consequent, ctx)
        : evalNode(n.alternate, ctx);
    case "CallExpression":
      return applyCall(n, ctx);
    default:
      throw new ExpressionError(`Unsupported expression: ${n.type}`);
  }
}

function resolveIdentifier(name: string, scope: Scope): unknown {
  if (name.startsWith("$")) return scope[name.slice(1)];
  throw new ExpressionError(`Unknown identifier: ${name} (payload paths must start with "$")`);
}

// Keys that expose the prototype chain — blocked so member access can never reach it, independent of
// the (separate) restriction that only identifier helper calls are allowed.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function member(object: unknown, key: unknown, optional: boolean): unknown {
  if (object === null || object === undefined) {
    if (optional) return undefined;
    throw new ExpressionError(`Cannot read "${String(key)}" of ${String(object)}`);
  }
  if (typeof object !== "object") {
    throw new ExpressionError(`Cannot index a ${typeof object}`);
  }
  const prop = String(key);
  if (UNSAFE_KEYS.has(prop)) {
    throw new ExpressionError(`Access to "${prop}" is not allowed`);
  }
  return (object as Record<string, unknown>)[prop];
}

function applyUnary(operator: string, arg: unknown): unknown {
  switch (operator) {
    case "!":
      return !arg;
    case "-":
      return -toNumber(arg);
    case "+":
      return toNumber(arg);
    default:
      throw new ExpressionError(`Unsupported unary operator: ${operator}`);
  }
}

function applyBinary(
  operator: string,
  leftNode: jsep.Expression,
  rightNode: jsep.Expression,
  ctx: EvalContext,
): unknown {
  // Logical and nullish operators short-circuit, so evaluate lazily.
  if (operator === "&&") return evalNode(leftNode, ctx) && evalNode(rightNode, ctx);
  if (operator === "||") return evalNode(leftNode, ctx) || evalNode(rightNode, ctx);
  if (operator === "??") {
    const left = evalNode(leftNode, ctx);
    return left ?? evalNode(rightNode, ctx);
  }

  const left = evalNode(leftNode, ctx);
  const right = evalNode(rightNode, ctx);
  switch (operator) {
    case "==":
    case "===":
      return left === right;
    case "!=":
    case "!==":
      return left !== right;
    case "<":
      return toNumber(left) < toNumber(right);
    case "<=":
      return toNumber(left) <= toNumber(right);
    case ">":
      return toNumber(left) > toNumber(right);
    case ">=":
      return toNumber(left) >= toNumber(right);
    case "+":
      return typeof left === "string" || typeof right === "string"
        ? `${stringify(left)}${stringify(right)}`
        : toNumber(left) + toNumber(right);
    case "-":
      return toNumber(left) - toNumber(right);
    case "*":
      return toNumber(left) * toNumber(right);
    case "/":
      return toNumber(left) / toNumber(right);
    case "%":
      return toNumber(left) % toNumber(right);
    default:
      throw new ExpressionError(`Unsupported operator: ${operator}`);
  }
}

function applyCall(node: jsep.CallExpression, ctx: EvalContext): unknown {
  if (!isIdentifier(node.callee)) {
    throw new ExpressionError("Only direct calls to whitelisted helpers are allowed");
  }
  const helper = ctx.helpers[node.callee.name];
  if (!helper) throw new ExpressionError(`Unknown helper: ${node.callee.name}`);
  const args = node.arguments.map((arg) => evalNode(arg, ctx));
  try {
    return helper(...args);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ExpressionError(`Helper "${node.callee.name}" failed: ${reason}`, { cause });
  }
}

function isIdentifier(node: jsep.Expression): node is jsep.Identifier {
  return node.type === "Identifier";
}

function identifierName(node: jsep.Expression): string {
  if (isIdentifier(node)) return node.name;
  throw new ExpressionError(`Expected a property name, got ${node.type}`);
}

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) throw new ExpressionError(`Not a number: ${String(value)}`);
  return n;
}

function stringify(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
