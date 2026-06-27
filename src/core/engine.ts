import type { BodyItem, Template } from "./template";
import type { DocumentNode, DocumentTree } from "./document-tree";
import type { EvalContext } from "./expression";
import { interpolate } from "./interpolate";
import { defaultHelpers, type HelperRegistry } from "./helpers";

export interface AssembleContext {
  /** The (validated) payload that `$paths` bind against. */
  scope?: Record<string, unknown>;
  /** Extra helpers, merged over the defaults. */
  helpers?: HelperRegistry;
}

/**
 * Tree assembly: evaluate a Template into a renderer-agnostic DocumentTree, binding `{{ expr }}`
 * tokens in inline text against the payload. The walking-skeleton node kinds (title/paragraph) are
 * still the only ones; Blocks, Clauses and control structures arrive in later slices.
 */
export function assembleTree(template: Template, context: AssembleContext = {}): DocumentTree {
  const ctx: EvalContext = {
    scope: context.scope ?? {},
    helpers: { ...defaultHelpers, ...context.helpers },
  };
  return template.body.map((item) => toNode(item, ctx));
}

function toNode(item: BodyItem, ctx: EvalContext): DocumentNode {
  if ("title" in item) return { kind: "title", text: interpolate(item.title, ctx) };
  if ("paragraph" in item) return { kind: "paragraph", text: interpolate(item.paragraph, ctx) };
  throw new Error(`Unsupported body item: ${JSON.stringify(item)}`);
}
