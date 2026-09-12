/**
 * The Edit set — the persisted artifact of one human editing pass.
 *
 * `{ schemaVersion, baseSnapshotId, ops, comments?, author?, at?, note? }` is plain JSON: a browser
 * builds it, an API validates it, a store keeps it next to the base Snapshot, and an auditor re-applies
 * it to re-derive the edited document. Because it crosses process boundaries, the zod schemas here —
 * not the TypeScript types — are what actually guard it.
 *
 * The artifact is called an **Edit set** everywhere. "Revision" is reserved for catalog drafts
 * (ADR-0009) and "Snapshot" for a generation.
 */

import { z } from "zod";
import type { Align, Assert, BlockIndent, DocumentNode, Mutual, PageFurniture } from "../document-tree";
import {
  alignSchema,
  blockIndentSchema,
  describeIssues,
  documentNodeSchema,
  pageFurnitureSchema,
  richTextV1Schema,
  type TreeIssue,
} from "../document-tree-schema";
import { LegalDocsError } from "../errors";
import type { RichTextV1 } from "../rich-text";
import type { TreePath } from "./tree-path";

/** The Edit set format this build writes. Independent of `SNAPSHOT_SCHEMA_VERSION`. */
export const EDIT_SET_SCHEMA_VERSION = 1;

/**
 * A node an editor may author. `custom` is excluded: a Custom block is code-side and opaque to editing
 * (ADR-0005), so it can be removed or moved but never inserted or replaced by a human. The rule holds
 * at every depth: an inserted article or list item may not smuggle a `custom` block in its body either,
 * otherwise an Edit set could hand a consumer's block implementation attacker-chosen `props`. The TS
 * type only excludes the top level; {@link editableNodeSchema} enforces the deep rule at runtime.
 */
export type EditableNode = Exclude<DocumentNode, { kind: "custom" }>;

/** True when `node` is, or anywhere inside contains, a `custom` block (article bodies and list items). */
export function containsCustomNode(node: DocumentNode): boolean {
  switch (node.kind) {
    case "custom":
      return true;
    case "article":
      return node.body.some(containsCustomNode);
    case "numberedList":
    case "bulletList":
    case "alphaList":
      return node.items.some((item) => item.some(containsCustomNode));
    default:
      return false;
  }
}

/** The closed set of Edit op kinds, as a runtime list. */
export const EDIT_OP_KINDS = [
  "setText",
  "setRichText",
  "setStyle",
  "replaceNode",
  "insertNode",
  "removeNode",
  "moveNode",
  "insertListItem",
  "removeListItem",
  "setFurniture",
] as const;

export type EditOpKind = (typeof EDIT_OP_KINDS)[number];

/**
 * One typed change to a DocumentTree, addressed by a {@link TreePath}. Ops are applied SEQUENTIALLY:
 * each resolves against the tree as the previous op left it (RFC 6902 style), so a UI building ops
 * against a stale view must rebase them (see `transformPath`).
 */
export type EditOp =
  /** Set an allow-listed string leaf; `null` deletes an optional one. */
  | { op: "setText"; path: TreePath; value: string | null }
  /** Replace a `richText` node's whole value. */
  | { op: "setRichText"; path: TreePath; value: RichTextV1 }
  /** Set `align` or `indent` on a title/paragraph; `null` clears the override. */
  | { op: "setStyle"; path: TreePath; value: Align | BlockIndent | null }
  | { op: "replaceNode"; path: TreePath; node: EditableNode }
  /** Insert before the node currently at `path` (an index equal to the list length appends). */
  | { op: "insertNode"; path: TreePath; node: EditableNode }
  | { op: "removeNode"; path: TreePath }
  /** Move a node; `to` is read against the tree AFTER the node was removed (RFC 6902 `move`). */
  | { op: "moveNode"; from: TreePath; to: TreePath }
  /** Insert a whole list item (a node list) at `…/items/<index>`. */
  | { op: "insertListItem"; path: TreePath; item: EditableNode[] }
  | { op: "removeListItem"; path: TreePath }
  /** Replace a whole `/header` or `/footer` object; `null` removes it. */
  | { op: "setFurniture"; path: TreePath; value: PageFurniture | null };

export type EditOpKindsAreExhaustive = Assert<Mutual<EditOpKind, EditOp["op"]>>;

/**
 * A review note anchored to a tree path. `path` is `null` once the node it pointed at was removed —
 * an orphaned comment is shown as such rather than silently dropped. `originalPath` and
 * `anchoredAfterOp` record where it was attached and how far the op log had run at the time, so a
 * session can re-derive the anchor deterministically on undo/redo.
 */
export interface Comment {
  id: string;
  path: TreePath | null;
  originalPath: TreePath;
  /** The number of ops applied when the comment was anchored. */
  anchoredAfterOp: number;
  text: string;
  /** The anchored node's text at anchoring time — a stale quote is flagged in the review view. */
  quote?: string;
  author?: string;
  /** ISO-8601 timestamp. */
  at?: string;
  resolved?: boolean;
}

export interface EditSet {
  schemaVersion: number;
  /** The id of the Snapshot whose tree the ops address. */
  baseSnapshotId: string;
  ops: EditOp[];
  comments?: Comment[];
  author?: string;
  /** ISO-8601 timestamp. */
  at?: string;
  note?: string;
}

export const treePathSchema = z.array(z.union([z.string(), z.number().int().nonnegative()]));

/** {@link documentNodeSchema} minus the `custom` escape hatch, at every depth — see {@link EditableNode}. */
export const editableNodeSchema = documentNodeSchema.refine((node) => !containsCustomNode(node), {
  message: "a custom block is opaque to editing (ADR-0005) — it cannot be inserted or replaced, not even nested inside an inserted node",
});

export const editOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setText"), path: treePathSchema, value: z.string().nullable() }),
  z.object({ op: z.literal("setRichText"), path: treePathSchema, value: richTextV1Schema }),
  z.object({ op: z.literal("setStyle"), path: treePathSchema, value: z.union([alignSchema, blockIndentSchema, z.null()]) }),
  z.object({ op: z.literal("replaceNode"), path: treePathSchema, node: editableNodeSchema }),
  z.object({ op: z.literal("insertNode"), path: treePathSchema, node: editableNodeSchema }),
  z.object({ op: z.literal("removeNode"), path: treePathSchema }),
  z.object({ op: z.literal("moveNode"), from: treePathSchema, to: treePathSchema }),
  z.object({ op: z.literal("insertListItem"), path: treePathSchema, item: z.array(editableNodeSchema) }),
  z.object({ op: z.literal("removeListItem"), path: treePathSchema }),
  z.object({ op: z.literal("setFurniture"), path: treePathSchema, value: pageFurnitureSchema.nullable() }),
]);

export const commentSchema = z.object({
  id: z.string(),
  path: treePathSchema.nullable(),
  originalPath: treePathSchema,
  anchoredAfterOp: z.number().int().nonnegative(),
  text: z.string(),
  quote: z.string().optional(),
  author: z.string().optional(),
  at: z.string().optional(),
  resolved: z.boolean().optional(),
});

export const editSetSchema = z.object({
  schemaVersion: z.number().int(),
  baseSnapshotId: z.string(),
  ops: z.array(editOpSchema),
  comments: z.array(commentSchema).optional(),
  author: z.string().optional(),
  at: z.string().optional(),
  note: z.string().optional(),
});

/**
 * zod cannot narrow a type through `.refine()`, so the `custom`-free node the schema enforces at
 * runtime is re-applied here before the lockstep comparison — the same normalize-the-one-intentional-
 * difference trick `RequireCustomProps` uses for the tree schema.
 */
type NormalizeNodes<T> = T extends { op: "replaceNode" | "insertNode" }
  ? Omit<T, "node"> & { node: EditableNode }
  : T extends { op: "insertListItem" }
    ? Omit<T, "item"> & { item: EditableNode[] }
    : T;

/**
 * Compile-time lockstep: adding an op kind or a field to the union without the schema (or the reverse)
 * makes these aliases a type error.
 */
export type EditOpSchemaMatchesUnion = Assert<Mutual<NormalizeNodes<z.infer<typeof editOpSchema>>, EditOp>>;
export type CommentSchemaMatchesInterface = Assert<Mutual<z.infer<typeof commentSchema>, Comment>>;
export type EditSetSchemaMatchesInterface = Assert<
  Mutual<Omit<z.infer<typeof editSetSchema>, "ops">, Omit<EditSet, "ops">>
>;

/**
 * A value is not a valid {@link EditSet}. Carries every zod issue (reusing the tree guard's
 * path-precise {@link TreeIssue} shape, which is just "where + why") so an API can answer with the
 * offending op index rather than a blob of text.
 */
export class EditSetValidationError extends LegalDocsError {
  constructor(
    message: string,
    readonly issues: readonly TreeIssue[],
  ) {
    super(message);
    this.name = "EditSetValidationError";
  }
}

/** Validate a value as an {@link EditSet}, throwing a path-precise {@link EditSetValidationError}. */
export function assertValidEditSet(value: unknown): asserts value is EditSet {
  assertValid(editSetSchema, value);
}

/**
 * Validate a single value as an {@link EditOp}. A malformed op is a programming error on the way IN —
 * an editor session refuses it before it reaches `applyEdits`, which keeps a rejected edit ("this op
 * does not apply to this tree", an `EditError`) distinguishable from a value that is not an op at all.
 */
export function assertValidEditOp(value: unknown): asserts value is EditOp {
  assertValid(editOpSchema, value);
}

function assertValid(schema: z.ZodType, value: unknown): void {
  const result = schema.safeParse(value);
  if (result.success) return;
  const issues: TreeIssue[] = result.error.issues.map((issue) => ({ path: [...issue.path], message: issue.message }));
  throw new EditSetValidationError(describeIssues(result.error.issues), issues);
}

/**
 * The path an op is reported against. `moveNode` has two — its source is the one that names the op in
 * an error, because that is where the op was authored.
 */
export function editOpPath(op: EditOp): TreePath {
  return op.op === "moveNode" ? op.from : op.path;
}
