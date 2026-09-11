/**
 * Tree paths — how the editing layer addresses a place in a {@link DocumentTree}.
 *
 * A path is an array of keys and indices mirroring the tree's own JSON shape (`["body", 2, "heading"]`
 * → `tree.body[2].heading`), with the canonical string form `/body/2/heading` used in error messages,
 * `data-path` attributes and logs. There are deliberately NO node ids: ids would either perturb every
 * persisted Snapshot id or need excluding from the hash, and would force an assignment pass through
 * the engine and a type change on every renderer. The accepted cost is that a path is only meaningful
 * against one tree state — {@link transformPath} shifts one through a structural op, and a UI holding
 * a stale path must rebase.
 *
 * {@link EditError} lives here rather than in its own module because every edit failure is located: it
 * is a path plus a reason, and the message is the path's canonical form.
 */

import { LegalDocsError } from "../errors";
import type { EditOp } from "./edit-set";

/** One step of a path: an object key, or an index into an array. */
export type TreePathSegment = string | number;

/**
 * A location in a {@link DocumentTree}, from the tree root. Plain arrays (this is a JSON artifact —
 * paths travel inside an Edit set), but treat them as immutable: the edit modules never write to one.
 */
export type TreePath = TreePathSegment[];

/** Why an edit was refused. A UI discriminates on this rather than matching the message. */
export type EditErrorReason =
  /** The path is malformed, or a segment is of the wrong sort (an index where a key belongs). */
  | "invalid-path"
  /** The key exists nowhere in the document model. */
  | "unknown-key"
  /** The key belongs to another node kind (`heading` on a paragraph). */
  | "wrong-kind"
  /** An index outside its list. */
  | "out-of-range"
  /** An optional container on the way is absent (a header slot on a document with no header). */
  | "missing"
  /** Reachable, but frozen by the editability table (article numbering, `custom` props, page setup). */
  | "not-editable"
  /** Editable, but not by this op (`setText` aimed at a node list). */
  | "wrong-target"
  /** The op's value does not fit its target (`null` on a required leaf, a value failing the schema). */
  | "invalid-value";

export interface EditErrorInit {
  reason: EditErrorReason;
  /** Where the edit was refused. Empty for a path that could not even be parsed. */
  path: TreePath;
  /** The human-readable half of the message, without the path prefix. */
  detail: string;
  /** The op kind, when the failure happened while applying one. */
  op?: EditOp["op"];
  /** The op's index in the Edit set, when the failure happened while applying one. */
  opIndex?: number;
}

/**
 * An edit could not be applied. Always carries the {@link EditErrorReason} and the {@link TreePath} it
 * failed at, and — when raised while applying an Edit set — the op kind and its index, so an API can
 * answer "op 3 (`setText`) at `/body/9/props`" without parsing the message.
 */
export class EditError extends LegalDocsError {
  readonly reason: EditErrorReason;
  readonly path: TreePath;
  readonly detail: string;
  readonly op?: EditOp["op"];
  readonly opIndex?: number;

  constructor(init: EditErrorInit) {
    super(describeEditFailure(init));
    this.name = "EditError";
    this.reason = init.reason;
    this.path = init.path;
    this.detail = init.detail;
    this.op = init.op;
    this.opIndex = init.opIndex;
  }

  /**
   * The same failure, restamped with the op it happened under. `applyEdits` uses this to add the op
   * context to an error raised by a path-level helper that knows nothing about Edit sets.
   */
  withOp(op: EditOp["op"], opIndex: number): EditError {
    return new EditError({ reason: this.reason, path: this.path, detail: this.detail, op, opIndex });
  }
}

function describeEditFailure(init: EditErrorInit): string {
  const where = formatTreePath(init.path);
  const prefix = init.opIndex === undefined ? "" : `op ${init.opIndex} (${init.op}) at `;
  return `${prefix}${where}: ${init.detail}`;
}

/** Build (but do not throw) an {@link EditError} — the terse form the locator and apply use. */
export function editError(reason: EditErrorReason, path: TreePath, detail: string): EditError {
  return new EditError({ reason, path, detail });
}

/** The canonical string form of a path: `/body/2/heading`, and `/` for the tree root. */
export function formatTreePath(path: readonly TreePathSegment[]): string {
  return `/${path.join("/")}`;
}

/**
 * Parse the canonical string form back into a path. A segment of digits only becomes a number — safe
 * because no key in the document model is numeric. Throws an `invalid-path` {@link EditError} for
 * anything that is not rooted at `/` or that carries an empty segment.
 */
export function parseTreePath(source: string): TreePath {
  if (!source.startsWith("/")) {
    throw editError("invalid-path", [], `a tree path must start with "/" (got ${JSON.stringify(source)})`);
  }
  if (source === "/") return [];
  return source
    .slice(1)
    .split("/")
    .map((segment) => {
      if (segment.length === 0) throw editError("invalid-path", [], `empty segment in ${JSON.stringify(source)}`);
      return /^\d+$/.test(segment) ? Number(segment) : segment;
    });
}

/**
 * Shift `path` through `op`, returning where it lands in the tree the op produces — or `null` when the
 * op removed it. Comments and editor selections survive structural edits this way.
 *
 * A `moveNode`'s `to` is interpreted against the tree AFTER the node was removed (RFC 6902 `move`
 * semantics), so a move is exactly a remove followed by an insert and needs no index correction here.
 * Non-structural ops (`setText`, `setStyle`, …) leave every path where it was.
 */
export function transformPath(path: TreePath, op: EditOp): TreePath | null {
  switch (op.op) {
    case "insertNode":
    case "insertListItem":
      return shiftForInsert(path, op.path);
    case "removeNode":
    case "removeListItem":
      return shiftForRemove(path, op.path);
    case "moveNode": {
      if (isAtOrUnder(path, op.from)) return [...op.to, ...path.slice(op.from.length)];
      const removed = shiftForRemove(path, op.from);
      return removed === null ? null : shiftForInsert(removed, op.to);
    }
    default:
      return path;
  }
}

/** `path` is `prefix` itself or a location inside it. */
function isAtOrUnder(path: TreePath, prefix: TreePath): boolean {
  return path.length >= prefix.length && prefix.every((segment, index) => path[index] === segment);
}

/** The position `at` addresses: the list it is in (all but the last segment) and the index within it. */
function positionOf(at: TreePath): { depth: number; index: number } | null {
  const depth = at.length - 1;
  const index = at[depth];
  return typeof index === "number" ? { depth, index } : null;
}

/** `path` sits in the same list as `at` — same parent, and its own segment at that depth is an index. */
function siblingIndex(path: TreePath, at: TreePath, depth: number): number | null {
  if (path.length <= depth) return null;
  for (let i = 0; i < depth; i += 1) if (path[i] !== at[i]) return null;
  const own = path[depth];
  return typeof own === "number" ? own : null;
}

function shiftForInsert(path: TreePath, at: TreePath): TreePath {
  const position = positionOf(at);
  if (position === null) return path;
  const own = siblingIndex(path, at, position.depth);
  if (own === null || own < position.index) return path;
  const shifted = [...path];
  shifted[position.depth] = own + 1;
  return shifted;
}

function shiftForRemove(path: TreePath, at: TreePath): TreePath | null {
  const position = positionOf(at);
  if (position === null) return path;
  const own = siblingIndex(path, at, position.depth);
  if (own === null || own < position.index) return path;
  if (own === position.index) return null;
  const shifted = [...path];
  shifted[position.depth] = own - 1;
  return shifted;
}
