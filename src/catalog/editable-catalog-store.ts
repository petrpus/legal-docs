import type { BaseTemplate, Include, Template, Variant } from "../core/template";
import type { Clause } from "../core/clause";
import type { CatalogStore } from "./catalog-store";
import type { AuditEntry } from "./audit";

/** The person (or system) performing an edit; recorded on every audit entry (ADR-0009). */
export interface Actor {
  id: string;
  name?: string;
  email?: string;
}

/** The workflow status of a revision. `published` is terminal and immutable. */
export type ElementStatus = "draft" | "in_review" | "published";

/**
 * A discriminated handle for an editable element. The revision identity differs by kind (ADR-0009):
 * clauses are versions-as-rows keyed by `id`; templates/includes by `id`; variants/bases by `family`.
 */
export type ElementRef =
  | { kind: "template"; id: string }
  | { kind: "base"; family: string }
  | { kind: "variant"; family: string; variant: string }
  | { kind: "include"; id: string }
  | { kind: "clause"; id: string };

/**
 * A draft's content payload: the existing core domain types, tagged by kind (a clause payload is one
 * locale row of a version; a clause draft may hold several such rows).
 */
export type ElementContent =
  | { kind: "template"; template: Template }
  | { kind: "base"; base: BaseTemplate }
  | { kind: "variant"; variant: Variant }
  | { kind: "include"; include: Include }
  | { kind: "clause"; clause: Clause };

/** Locates a specific draft. `version` is present for clause drafts (allocated at createDraft). */
export interface DraftRef {
  ref: ElementRef;
  version?: number;
}

/** A draft's current state, as returned by the editable store. */
export interface DraftHandle {
  draft: DraftRef;
  status: Exclude<ElementStatus, "published">;
  /** One entry per authored payload; a clause draft accumulates one entry per locale row. */
  content: ElementContent[];
  updatedAt: string;
  updatedBy: Actor;
}

/** The outcome of publishing a draft: the now-published revision. */
export interface PublishResult {
  ref: ElementRef;
  version: number;
  /** For a clause, the locale rows that became published (a version can be partially translated). */
  locales?: string[];
  publishedAt: string;
}

/**
 * The write seam (ADR-0009): a store that also supports drafting, a `draft → in_review → published`
 * workflow, and an audit log. It **extends** the read-only `CatalogStore` rather than mutating it, so
 * every existing reader is unaffected and the file store need not implement writes.
 *
 * Invariant it must honour: the inherited read methods (`loadClause`, `clauseVersions`, `loadTemplate`,
 * …) surface **only published** content — drafts are reachable exclusively through the methods here.
 * That is what makes `@latest` resolve to the newest *published* version for free.
 */
export interface EditableCatalogStore extends CatalogStore {
  // Content-mutators take an options object; workflow transitions take positional `(draft, actor)`.

  /**
   * Create a new draft for an element. A clause draft allocates a new version here (`max + 1`, counting
   * drafts) when editing wording; to add a translation to an *existing* version, pass a `content`
   * whose `clause.version` is that version — `createDraft` seeds the first locale row, `updateDraft`
   * adds the rest.
   */
  createDraft(init: { ref: ElementRef; content: ElementContent; actor: Actor }): Promise<DraftHandle>;
  /**
   * Upsert a content row into the draft. For a clause, the row is keyed by `clause.locale` — a new
   * locale adds a row (the ADR's additive-translation path), an existing one replaces it; for
   * single-row elements it replaces the content. Rejects if the target is already published.
   */
  updateDraft(update: { draft: DraftRef; content: ElementContent; actor: Actor }): Promise<DraftHandle>;
  /** Discard a draft (rejects if already published). */
  deleteDraft(draft: DraftRef, actor: Actor): Promise<void>;

  /** List drafts (the editable side — deliberately not part of the read `CatalogStore`). */
  listDrafts(filter?: { kind?: ElementRef["kind"]; status?: ElementStatus }): Promise<DraftHandle[]>;
  /** Load a single draft, or undefined if none. */
  loadDraft(draft: DraftRef): Promise<DraftHandle | undefined>;

  /** draft → in_review. */
  submitForReview(draft: DraftRef, actor: Actor): Promise<DraftHandle>;
  /** in_review → draft. */
  withdraw(draft: DraftRef, actor: Actor): Promise<DraftHandle>;
  /** in_review → published (writes the published row; the sole publisher). */
  publish(draft: DraftRef, actor: Actor): Promise<PublishResult>;

  /** The edit audit trail, optionally filtered. */
  auditLog(filter?: { ref?: ElementRef; actorId?: string; since?: string }): Promise<AuditEntry[]>;
}

/**
 * Narrow a (read) store to an editable one — the facade uses this to expose the `editing` API.
 * Duck-types on `createDraft`; assumes a store that implements that method implements the whole
 * interface (true for the first-party adapters — memory, sqlite).
 */
export function isEditableStore(store: CatalogStore): store is EditableCatalogStore {
  return typeof (store as Partial<EditableCatalogStore>).createDraft === "function";
}
