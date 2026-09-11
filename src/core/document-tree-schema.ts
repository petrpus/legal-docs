/**
 * The runtime guard for the {@link DocumentTree} — a zod mirror of the `DocumentNode` union.
 *
 * The TypeScript union in `document-tree.ts` stays the authority on shape; this module makes that
 * shape checkable at runtime, so a tree that crossed a process boundary (a persisted Snapshot, an
 * HTTP body, an editor's output) is rejected with a path-precise error instead of failing deep inside
 * a renderer. The two are kept in lockstep by {@link DocumentNodeSchemaMatchesUnion} (compile time)
 * and by a test comparing the schema's discriminants with `DOCUMENT_NODE_KINDS` (runtime).
 *
 * Schemas are PLAIN objects, never `.strict()`: a Snapshot is a long-lived artifact, so a tree written
 * by a newer build (carrying a field this build doesn't know) must still validate and re-render.
 * A `custom` node is checked only for `component` — its `props` is opaque by design (ADR-0005).
 */

import { z } from "zod";
import {
  ALIGN_VALUES,
  type Assert,
  type DocumentNode,
  type DocumentNodeKind,
  type DocumentTree,
  type Mutual,
  type PageFurniture,
} from "./document-tree";
import { LegalDocsError } from "./errors";
import { PAGE_SIZES, type PageSetup, type PageSizeName } from "./page";
import { MARK_VALUES, type RichTextV1 } from "./rich-text";

/** The definition name the recursive node list is hoisted to in a JSON Schema export. */
export const DOCUMENT_NODE_LIST_SCHEMA_ID = "documentNodeList";

export const richRunSchema = z.object({
  text: z.string(),
  marks: z.array(z.enum(MARK_VALUES)).optional(),
});

export const richParagraphSchema = z.object({
  type: z.literal("paragraph"),
  runs: z.array(richRunSchema),
});

export const richTextV1Schema = z.object({
  type: z.literal("doc"),
  blocks: z.array(richParagraphSchema),
});

export const alignSchema = z.enum(ALIGN_VALUES);

// Design points, matching the engine's authoring rule (`indent`/`firstLineIndent` must be
// non-negative numbers). `z.number()` already rejects NaN and the infinities.
export const blockIndentSchema = z.object({
  firstLine: z.number().nonnegative().optional(),
  left: z.number().nonnegative().optional(),
});

export const partyIdentificationSchema = z.object({
  name: z.string(),
  kind: z.enum(["person", "company"]).optional(),
  idNumber: z.string().optional(),
  address: z.string().optional(),
});

export const keyValueRowSchema = z.object({ label: z.string(), value: z.string() });

export const signaturePlaceSchema = z.object({ name: z.string(), role: z.string().optional() });

/**
 * A forward reference to the node union, annotated so the recursion below (`article.body`, list
 * `items`) does not make TypeScript's inference circular — the concrete option schemas can then be
 * written inline and `z.infer<typeof documentNodeSchema>` stays a real, checkable union.
 */
const nodeRef: z.ZodType<DocumentNode> = z.lazy(() => documentNodeSchema);
// Named, because this is the recursion point: `article.body`, every list `items` entry and the tree's
// own `body` all reuse it, so a JSON Schema export hoists it into a `$ref`ed definition under this id
// instead of an anonymous `__schema0`.
const nodeListSchema = z.array(nodeRef).meta({ id: DOCUMENT_NODE_LIST_SCHEMA_ID });

const styledBlock = { align: alignSchema.optional(), indent: blockIndentSchema.optional() };

export const documentNodeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("title"), text: z.string(), ...styledBlock }),
  z.object({ kind: z.literal("paragraph"), text: z.string(), ...styledBlock }),
  z.object({ kind: z.literal("richText"), value: richTextV1Schema }),
  z.object({
    kind: z.literal("article"),
    no: z.string(),
    level: z.number().int(),
    heading: z.string().optional(),
    body: nodeListSchema,
  }),
  z.object({ kind: z.literal("numberedList"), items: z.array(nodeListSchema) }),
  z.object({ kind: z.literal("bulletList"), items: z.array(nodeListSchema) }),
  z.object({ kind: z.literal("alphaList"), items: z.array(nodeListSchema) }),
  z.object({ kind: z.literal("partyHeader"), party: partyIdentificationSchema, roleLabel: z.string() }),
  z.object({ kind: z.literal("keyValueTable"), rows: z.array(keyValueRowSchema) }),
  z.object({ kind: z.literal("signatures"), places: z.array(signaturePlaceSchema) }),
  z.object({ kind: z.literal("custom"), component: z.string(), props: z.unknown() }),
]);

/**
 * The node kinds this schema actually validates, read back off the discriminated union. The runtime
 * half of the lockstep with `DOCUMENT_NODE_KINDS`: the two lists are authored independently, so a
 * kind added to only one of them is caught by the test that compares them.
 */
export function documentNodeKinds(): DocumentNodeKind[] {
  return documentNodeSchema.options.map((option) => option.shape.kind.value);
}

export const pageFurnitureSchema = z.object({
  left: z.string().optional(),
  center: z.string().optional(),
  right: z.string().optional(),
});

export const pageSetupSchema = z.object({
  size: z.enum(Object.keys(PAGE_SIZES) as PageSizeName[]).optional(),
  orientation: z.enum(["portrait", "landscape"]).optional(),
});

export const documentTreeSchema = z.object({
  body: nodeListSchema,
  header: pageFurnitureSchema.optional(),
  footer: pageFurnitureSchema.optional(),
  page: pageSetupSchema.optional(),
});

/**
 * zod infers a key whose value type is `unknown` as OPTIONAL (`props?: unknown`), while
 * `DocumentNode` declares `custom.props` as required-but-opaque. That is the single intentional
 * difference between the two, so it is normalized away before the lockstep comparison below.
 */
type RequireCustomProps<T> = T extends { kind: "custom" } ? T & { props: unknown } : T;

/**
 * Compile-time lockstep: the schema and the hand-written union must describe the same shapes. Adding
 * a node kind or a field to one without the other makes these aliases a type error. Exported so they
 * are part of the module's checked surface rather than dead code.
 */
export type DocumentNodeSchemaMatchesUnion = Assert<
  Mutual<RequireCustomProps<z.infer<typeof documentNodeSchema>>, DocumentNode>
>;
export type DocumentTreeSchemaMatchesInterface = Assert<
  Mutual<
    Omit<z.infer<typeof documentTreeSchema>, "body">,
    Omit<DocumentTree, "body">
  >
>;
export type RichTextSchemaMatchesInterface = Assert<Mutual<z.infer<typeof richTextV1Schema>, RichTextV1>>;
export type PageFurnitureSchemaMatchesInterface = Assert<Mutual<z.infer<typeof pageFurnitureSchema>, PageFurniture>>;
export type PageSetupSchemaMatchesInterface = Assert<Mutual<z.infer<typeof pageSetupSchema>, PageSetup>>;

/** One rejected location in a tree: where it is and why it failed. */
export interface TreeIssue {
  /** Path from the tree root, e.g. `["body", 0, "align"]`. */
  path: PropertyKey[];
  message: string;
}

/**
 * A value is not a valid {@link DocumentTree}. Carries every zod issue so a caller (an editor, an API)
 * can point at the offending node rather than parse the message.
 */
export class TreeValidationError extends LegalDocsError {
  constructor(
    message: string,
    readonly issues: readonly TreeIssue[],
  ) {
    super(message);
    this.name = "TreeValidationError";
  }
}

/**
 * Validate a value as a {@link DocumentTree}, throwing a path-precise {@link TreeValidationError}
 * naming the first offending location. A bare `DocumentNode[]` is NOT accepted — callers holding one
 * normalize it with `asDocumentTree` first.
 */
export function assertValidTree(value: unknown): asserts value is DocumentTree {
  const result = documentTreeSchema.safeParse(value);
  if (result.success) return;
  const issues: TreeIssue[] = result.error.issues.map((issue) => ({ path: [...issue.path], message: issue.message }));
  throw new TreeValidationError(describeIssues(result.error.issues), issues);
}

/**
 * `"body.0.align: Invalid option …"` — the first issue, located from the tree root. Shared with the
 * Snapshot guard so a malformed tree reads the same however it was caught.
 */
export function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  const first = issues[0];
  if (!first) return "invalid document tree";
  const where = first.path.length > 0 ? first.path.join(".") : "(root)";
  return `${where}: ${first.message}`;
}
