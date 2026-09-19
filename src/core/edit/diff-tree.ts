/**
 * `diffTree` — the flat, path-addressed view of what an Edit set did.
 *
 * Where a {@link RedlineDoc} mirrors the document (so a renderer can walk it), this is the list a UI or
 * an audit log wants: one entry per difference, each naming the {@link TreePath} it happened at. It is
 * literally the flattening of `buildRedline`, so the change list and the rendered redline can never
 * disagree — there is one alignment, computed once, read two ways.
 *
 * Paths are in the EDITED tree, except a removal, which keeps its path in the base tree: that is the
 * only tree the removed node exists in. Because tree paths are positional (ADR-0014), a move surfaces
 * as a removal plus an insertion, and so does any change to a node's kind, an article's number/level or
 * a `custom` block's props.
 */

import type { Align, BlockIndent, DocumentBody, DocumentNode, DocumentTree } from "../document-tree";
import type { RichTextV1 } from "../rich-text";
import { buildRedline, type RedlineAttr, type RedlineBlock, type RedlineField } from "./redline-model";
import type { TreePath } from "./tree-path";

/** One difference between two document trees. */
export type TreeChange =
  /** A node that exists only in the edited tree. */
  | { change: "inserted"; path: TreePath; node: DocumentNode }
  /** A node that exists only in the base tree, at its path THERE. */
  | { change: "removed"; path: TreePath; node: DocumentNode }
  /** A whole list item that exists only in the edited tree. */
  | { change: "insertedItem"; path: TreePath; item: DocumentNode[] }
  /** A whole list item that exists only in the base tree, at its path THERE. */
  | { change: "removedItem"; path: TreePath; item: DocumentNode[] }
  /** A string leaf whose value differs; `undefined` means the optional leaf was absent on that side. */
  | { change: "text"; path: TreePath; before: string | undefined; after: string | undefined }
  /** A `richText` node's whole value. */
  | { change: "richText"; path: TreePath; before: RichTextV1; after: RichTextV1 }
  /** A block attribute (`align`, `indent`); `undefined` means no override on that side. */
  | { change: "attr"; path: TreePath; before: Align | BlockIndent | undefined; after: Align | BlockIndent | undefined };

/**
 * Every difference between a base tree and an edited one, in document order (page furniture last).
 * Two identical trees produce an empty list. Neither input is mutated.
 */
export function diffTree(base: DocumentTree | DocumentBody, edited: DocumentTree | DocumentBody): TreeChange[] {
  const redline = buildRedline(base, edited);
  return [...flattenBlocks(redline.blocks), ...redline.furniture.flatMap(fieldChanges)];
}

function flattenBlocks(blocks: readonly RedlineBlock[]): TreeChange[] {
  return blocks.flatMap<TreeChange>((block) => {
    switch (block.status) {
      case "unchanged":
        return [];
      case "inserted":
        return [{ change: "inserted", path: block.path, node: block.node }];
      case "deleted":
        return [{ change: "removed", path: block.path, node: block.node }];
      case "textChanged":
        return [...block.fields.flatMap(fieldChanges), ...attrChanges(block.attrs)];
      case "attrsChanged":
        return attrChanges(block.attrs);
      case "container":
        return [...block.fields.flatMap(fieldChanges), ...flattenChildren(block.children)];
    }
  });
}

function flattenChildren(children: Extract<RedlineBlock, { status: "container" }>["children"]): TreeChange[] {
  if (children.of === "body") return flattenBlocks(children.blocks);
  return children.items.flatMap<TreeChange>((item) => {
    switch (item.status) {
      case "unchanged":
        return [];
      case "inserted":
        return [{ change: "insertedItem", path: item.path, item: item.blocks.map((block) => block.node) }];
      case "deleted":
        return [{ change: "removedItem", path: item.path, item: item.blocks.map((block) => block.node) }];
      case "changed":
        return flattenBlocks(item.blocks);
    }
  });
}

function fieldChanges(field: RedlineField): TreeChange[] {
  return field.kind === "text"
    ? [{ change: "text", path: field.path, before: field.before, after: field.after }]
    : [{ change: "richText", path: field.path, before: field.before, after: field.after }];
}

function attrChanges(attrs: readonly RedlineAttr[]): TreeChange[] {
  return attrs.map((attr) => ({ change: "attr", path: attr.path, before: attr.before, after: attr.after }));
}
