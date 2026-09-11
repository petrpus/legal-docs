/**
 * `createEditSession` — the editing state an editor UI drives.
 *
 * The session is deliberately framework-agnostic: it owns an **op log plus a cursor**, not a stack of
 * trees-as-state, so undo is "move the cursor back" and the Edit set it exports is simply the ops up to
 * that cursor. Every prefix of the log is memoized, which makes undo/redo allocation-free and — more
 * importantly — makes `session.tree` a reference that only changes when the document actually changed,
 * the contract React's `useSyncExternalStore` needs from a `getSnapshot`. {@link EditSession.subscribe}
 * is the matching `subscribe`.
 *
 * Nothing here reaches for a Node built-in: the session runs in the browser (ADR-0012), and only
 * identity (`buildEditedSnapshot`, `node:crypto`) and the PDF/DOCX exporters stay on the server. That is
 * also why the base Snapshot is taken structurally as {@link EditSessionBase} rather than imported as a
 * `Snapshot` — `src/core/snapshot.ts` hashes, so importing its type would drag the module in.
 */

import type { DocumentNode, DocumentTree } from "../core/document-tree";
import { assertValidTree } from "../core/document-tree-schema";
import {
  applyEdits,
  assertValidEditOp,
  assertValidEditSet,
  EditError,
  EDIT_SET_SCHEMA_VERSION,
  locate,
  type Comment,
  type EditOp,
  type EditSet,
  type TreePath,
} from "../core/edit";
import { LegalDocsError } from "../core/errors";
import { renderTreeToHtml, type RenderHtmlOptions } from "../render-html/render-html";

/**
 * What a session needs of a base Snapshot: its id, and the tree it froze. Structural on purpose — any
 * `Snapshot` in `full` or `tree` mode satisfies it, without the editing layer importing the Snapshot
 * module (which hashes with `node:crypto` and would break the browser build).
 */
export interface EditSessionBase {
  /** The base Snapshot's id — stamped on the Edit set as `baseSnapshotId`. */
  id: string;
  /** The frozen tree. Absent in `pins` mode, which carries no document to edit. */
  tree?: DocumentTree;
}

export interface EditSessionInit {
  /** The document to edit: a base Snapshot, or a bare tree (then `baseSnapshotId` identifies it). */
  base: DocumentTree | EditSessionBase;
  /** The base Snapshot id, when `base` is a bare tree. Must agree with a Snapshot base's own id. */
  baseSnapshotId?: string;
  /** Resume an editing pass: its ops are replayed and the cursor lands at their end. */
  editSet?: EditSet;
  /** Stamped on the exported Edit set. Defaults to the resumed Edit set's author. */
  author?: string;
  /** Stamped on the exported Edit set. Defaults to the resumed Edit set's note. */
  note?: string;
  /** The clock `toEditSet` reads, as an ISO-8601 string. Injectable so a test is deterministic. */
  now?: () => string;
  /** Preview theme — a partial theme deep-merged over `defaultTheme`. */
  theme?: RenderHtmlOptions["theme"];
  /** Custom block implementations the preview renders with. */
  customBlocks?: RenderHtmlOptions["customBlocks"];
}

/**
 * The outcome of {@link EditSession.apply}: an op that does not apply to the current tree is an ordinary
 * answer a UI shows next to the field, not an exception. (A MALFORMED op — one that is not an
 * {@link EditOp} at all — still throws: that is a bug in the caller, not a rejected edit.)
 */
export type EditApplyResult = { ok: true; tree: DocumentTree } | { ok: false; error: EditError };

export interface EditSession {
  /** The unedited tree the session started from. Never changes. Treat as read-only. */
  readonly base: DocumentTree;
  /** The base Snapshot's id, when one is known. */
  readonly baseSnapshotId: string | undefined;
  /** The tree as the ops up to the cursor leave it. A new reference exactly when it changed. */
  readonly tree: DocumentTree;
  /** The whole op log, INCLUDING any redo tail beyond the cursor. */
  readonly ops: readonly EditOp[];
  /** How many ops are applied — the boundary between history and the redo tail. */
  readonly cursor: number;
  /** Whether the current tree differs from the base (i.e. at least one op is applied). */
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Apply one op, truncating the redo tail. */
  apply(op: EditOp): EditApplyResult;
  /** Step the cursor back one op. `false` when already at the base. */
  undo(): boolean;
  /** Step the cursor forward one op. `false` when there is no redo tail left. */
  redo(): boolean;
  /** The node at `path` in the current tree, or `undefined` when the path addresses no node. */
  getNode(path: TreePath): DocumentNode | undefined;
  /** The current tree as HTML. `emitPaths` defaults to `true` — a UI selects by `data-path`. */
  preview(options?: RenderHtmlOptions): string;
  /** Freeze the ops up to the cursor as an Edit set. Carries no id: the server stamps identity. */
  toEditSet(): EditSet;
  /** Register a change listener; call the returned function to stop listening. */
  subscribe(listener: () => void): () => void;
}

/** A session could not be started, or cannot produce an Edit set. */
export class EditSessionError extends LegalDocsError {
  constructor(message: string) {
    super(message);
    this.name = "EditSessionError";
  }
}

/**
 * Start an editing pass over a base Snapshot (or a bare tree). Throws a `TreeValidationError` for an
 * invalid base, an {@link EditSessionError} for a base that cannot be edited or an Edit set built
 * against a different Snapshot, and an {@link EditError} when a resumed Edit set does not replay.
 */
export function createEditSession(init: EditSessionInit): EditSession {
  return new Session(init);
}

class Session implements EditSession {
  readonly base: DocumentTree;
  readonly baseSnapshotId: string | undefined;

  /** The op log. Ops beyond {@link cursor} are the redo tail. */
  private readonly log: EditOp[] = [];
  /** `trees[i]` is the tree after `i` ops — `trees[0]` is the base. Always `log.length + 1` long. */
  private readonly trees: DocumentTree[];
  private position = 0;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => string;
  private readonly author?: string;
  private readonly note?: string;
  /**
   * Comments carried through from a resumed Edit set. Anchoring, rebasing and orphaning are the next
   * slice (#155); until then they travel with the Edit set untouched rather than being dropped.
   */
  private readonly comments: Comment[];
  private readonly renderOptions: RenderHtmlOptions;

  constructor(init: EditSessionInit) {
    // A resumed Edit set arrives from storage or over the wire, so it is guarded before anything reads it.
    if (init.editSet !== undefined) assertValidEditSet(init.editSet);
    const resolved = resolveBase(init);
    assertValidTree(resolved.tree);
    this.base = structuredClone(resolved.tree);
    this.baseSnapshotId = resolved.baseSnapshotId;
    this.trees = [this.base];
    this.now = init.now ?? (() => new Date().toISOString());
    this.author = init.author ?? init.editSet?.author;
    this.note = init.note ?? init.editSet?.note;
    this.comments = structuredClone(init.editSet?.comments ?? []);
    this.renderOptions = { theme: init.theme, customBlocks: init.customBlocks };
    for (const op of init.editSet?.ops ?? []) {
      const result = this.apply(op);
      // A resumed Edit set is a persisted artifact: if it no longer replays, the caller is holding the
      // wrong base, and a half-applied session would hide that.
      if (!result.ok) throw result.error;
    }
  }

  get tree(): DocumentTree {
    return this.trees[this.position]!;
  }

  get ops(): readonly EditOp[] {
    return this.log;
  }

  get cursor(): number {
    return this.position;
  }

  get dirty(): boolean {
    return this.position > 0;
  }

  get canUndo(): boolean {
    return this.position > 0;
  }

  get canRedo(): boolean {
    return this.position < this.log.length;
  }

  apply(op: EditOp): EditApplyResult {
    assertValidEditOp(op);
    let next: DocumentTree;
    try {
      next = applyEdits(this.tree, [op]);
    } catch (error) {
      // `applyEdits` numbers ops within the call it was given; restamp with the index this op would
      // have taken in the session's own log, which is the index a UI can point at.
      if (error instanceof EditError) return { ok: false, error: error.withOp(op.op, this.position) };
      throw error;
    }
    // Applying after an undo abandons the redo tail — history stays linear (no branching, ADR-0014).
    this.log.length = this.position;
    this.trees.length = this.position + 1;
    // Own the op: a caller mutating the object it passed must not rewrite this session's history.
    this.log.push(structuredClone(op));
    this.trees.push(next);
    this.position += 1;
    this.notify();
    return { ok: true, tree: next };
  }

  undo(): boolean {
    return this.moveTo(this.position - 1);
  }

  redo(): boolean {
    return this.moveTo(this.position + 1);
  }

  getNode(path: TreePath): DocumentNode | undefined {
    try {
      const location = locate(this.tree, path);
      return location.kind === "node" ? location.node : undefined;
    } catch (error) {
      if (error instanceof EditError) return undefined;
      throw error;
    }
  }

  preview(options: RenderHtmlOptions = {}): string {
    return renderTreeToHtml(this.tree, { emitPaths: true, ...this.renderOptions, ...options });
  }

  toEditSet(): EditSet {
    if (this.baseSnapshotId === undefined) {
      throw new EditSessionError(
        "this session was started from a bare tree, so the Edit set has no base Snapshot to point at — " +
          "start it from a Snapshot, or pass `baseSnapshotId`",
      );
    }
    const editSet: EditSet = {
      schemaVersion: EDIT_SET_SCHEMA_VERSION,
      baseSnapshotId: this.baseSnapshotId,
      ops: structuredClone(this.log.slice(0, this.position)),
      at: this.now(),
    };
    if (this.comments.length > 0) editSet.comments = structuredClone(this.comments);
    if (this.author !== undefined) editSet.author = this.author;
    if (this.note !== undefined) editSet.note = this.note;
    return editSet;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Move the cursor, notifying only when it actually moved (nothing changed = no re-render). */
  private moveTo(position: number): boolean {
    if (position < 0 || position > this.log.length) return false;
    this.position = position;
    this.notify();
    return true;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function resolveBase(init: EditSessionInit): { tree: DocumentTree; baseSnapshotId: string | undefined } {
  const baseSnapshotId = baseIdOf(init);
  if (isTree(init.base)) return { tree: init.base, baseSnapshotId };
  if (!init.base.tree) {
    throw new EditSessionError(
      `snapshot ${init.base.id} carries no tree — a "pins"-mode Snapshot must be re-rendered before it can be edited`,
    );
  }
  return { tree: init.base.tree, baseSnapshotId };
}

/**
 * The one base id, from up to three sources that must agree: the base Snapshot, an explicit
 * `baseSnapshotId`, and the resumed Edit set. A mismatch means the caller is editing the wrong
 * document — the failure a `verifyEditedSnapshot` would otherwise only catch after export.
 */
function baseIdOf(init: EditSessionInit): string | undefined {
  const claims: { source: string; id: string }[] = [];
  if (!isTree(init.base)) claims.push({ source: "the base Snapshot", id: init.base.id });
  if (init.baseSnapshotId !== undefined) claims.push({ source: "baseSnapshotId", id: init.baseSnapshotId });
  if (init.editSet !== undefined) claims.push({ source: "the Edit set", id: init.editSet.baseSnapshotId });
  const first = claims[0];
  if (first === undefined) return undefined;
  const disagreeing = claims.find((claim) => claim.id !== first.id);
  if (disagreeing !== undefined) {
    throw new EditSessionError(
      `${first.source} names base Snapshot ${first.id}, but ${disagreeing.source} names ${disagreeing.id}`,
    );
  }
  return first.id;
}

function isTree(base: DocumentTree | EditSessionBase): base is DocumentTree {
  return Array.isArray((base as DocumentTree).body);
}
