import type { BodyItem, Template } from "./template";
import type { DocumentNode, DocumentTree } from "./document-tree";

/**
 * Tree assembly: evaluate a Template into a renderer-agnostic DocumentTree.
 * The walking skeleton maps inline `title` / `paragraph` items directly to nodes.
 */
export function assembleTree(template: Template): DocumentTree {
  return template.body.map(toNode);
}

function toNode(item: BodyItem): DocumentNode {
  if ("title" in item) return { kind: "title", text: item.title };
  if ("paragraph" in item) return { kind: "paragraph", text: item.paragraph };
  throw new Error(`Unsupported body item: ${JSON.stringify(item)}`);
}
