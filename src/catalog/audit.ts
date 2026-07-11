import type { Actor, ElementRef, ElementStatus } from "./editable-catalog-store";

/**
 * The edit audit trail (ADR-0009): every draft CRUD + status transition is recorded by the store,
 * atomically with the change, so the log can never drift from the content state. This is orthogonal to
 * the *content* audit (`ClausePin`/`Snapshot`), which freezes which element versions went into a
 * rendered document — that answers "what was in this document"; this answers "who changed the catalog".
 */
export type AuditAction =
  | "create_draft"
  | "update_draft"
  | "delete_draft"
  | "submit"
  | "withdraw"
  | "publish";

export interface AuditEntry {
  /** Monotonic entry id (e.g. a ULID); orders the log. */
  id: string;
  /** ISO-8601 timestamp of the action. */
  at: string;
  actor: Actor;
  action: AuditAction;
  /** The element the action targeted. */
  element: ElementRef;
  /** The concrete revision touched, when applicable (clause version/locale; element version). */
  revision?: { version?: number; locale?: string };
  /** Status before/after, for transition actions. */
  from?: ElementStatus;
  to?: ElementStatus;
  /** Optional free-text note (e.g. a review comment). */
  note?: string;
}
