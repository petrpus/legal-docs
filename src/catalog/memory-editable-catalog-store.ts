import type { Clause } from "../core/clause";
import { MemoryCatalogStore } from "./memory-catalog-store";
import {
  describeRef,
  type Actor,
  type DraftHandle,
  type DraftRef,
  type EditableCatalogStore,
  type ElementContent,
  type ElementRef,
  type ElementStatus,
  type PublishResult,
} from "./editable-catalog-store";
import type { AuditAction, AuditEntry } from "./audit";

/** Internal draft record: a clause draft accumulates one content row per locale. */
interface DraftRecord {
  ref: ElementRef;
  version: number;
  status: Exclude<ElementStatus, "published">;
  rows: Map<string, ElementContent>; // locale → content
  updatedAt: string;
  updatedBy: Actor;
}

/** Options for {@link MemoryEditableCatalogStore} (injectable clock for deterministic tests). */
export interface MemoryEditableOptions {
  /** Timestamp source for `updatedAt` / audit `at`; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * The in-memory reference {@link EditableCatalogStore} (ADR-0009). This slice implements the full
 * lifecycle for **clauses**; templates/includes/variants land in later slices and throw a clear
 * "not yet supported" until then. Drafts live outside the published set inherited from
 * {@link MemoryCatalogStore}, so they are invisible to `@latest` and every read method until published;
 * `publish` is the sole writer of a published row, and every transition is audited.
 */
export class MemoryEditableCatalogStore extends MemoryCatalogStore implements EditableCatalogStore {
  private readonly drafts = new Map<string, DraftRecord>();
  private readonly audit: AuditEntry[] = [];
  private auditSeq = 0;
  private readonly now: () => string;

  constructor(seed?: ConstructorParameters<typeof MemoryCatalogStore>[0], opts: MemoryEditableOptions = {}) {
    super(seed);
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  async createDraft(init: { ref: ElementRef; content: ElementContent; actor: Actor }): Promise<DraftHandle> {
    const { clause, id } = this.asClause(init.ref, init.content);
    const published = await this.clauseVersions(id);
    const draftVersions = this.clauseDraftVersions(id);
    // An existing *published* version → an additive-translation draft on it; otherwise a new version.
    const version = published.includes(clause.version)
      ? clause.version
      : Math.max(0, ...published, ...draftVersions) + 1;
    const key = clauseKey(id, version);
    if (this.drafts.has(key)) {
      throw new Error(`A draft for clause "${id}" v${version} already exists; use updateDraft`);
    }
    await this.assertNotPublished(id, version, clause.locale);
    const rec: DraftRecord = {
      ref: init.ref,
      version,
      status: "draft",
      rows: new Map([[clause.locale, withVersion(init.content, version)]]),
      updatedAt: this.now(),
      updatedBy: init.actor,
    };
    this.drafts.set(key, rec);
    this.record(init.actor, "create_draft", init.ref, { version, locale: clause.locale }, undefined, "draft");
    return toHandle(rec);
  }

  async updateDraft(update: { draft: DraftRef; content: ElementContent; actor: Actor }): Promise<DraftHandle> {
    const rec = this.requireDraft(update.draft);
    // Content can only change while in `draft` — editing a submitted (`in_review`) draft would let the
    // published content differ from what was reviewed. Withdraw it first (ADR-0009 workflow).
    if (rec.status !== "draft") throw new Error(`Cannot edit a "${rec.status}" draft; withdraw it first`);
    const { clause, id } = this.asClause(rec.ref, update.content);
    await this.assertNotPublished(id, rec.version, clause.locale);
    rec.rows.set(clause.locale, withVersion(update.content, rec.version));
    rec.updatedAt = this.now();
    rec.updatedBy = update.actor;
    this.record(update.actor, "update_draft", rec.ref, { version: rec.version, locale: clause.locale });
    return toHandle(rec);
  }

  /** Discard a draft entirely. Allowed from either `draft` or `in_review` (rejecting = discarding). */
  async deleteDraft(draft: DraftRef, actor: Actor): Promise<void> {
    const rec = this.requireDraft(draft);
    this.drafts.delete(clauseKey(clauseId(rec.ref), rec.version));
    this.record(actor, "delete_draft", rec.ref, { version: rec.version });
  }

  listDrafts(filter?: { kind?: ElementRef["kind"]; status?: ElementStatus }): Promise<DraftHandle[]> {
    const out = [...this.drafts.values()]
      .filter((r) => (filter?.kind ? r.ref.kind === filter.kind : true))
      .filter((r) => (filter?.status ? r.status === filter.status : true))
      .map(toHandle);
    return Promise.resolve(out);
  }

  loadDraft(draft: DraftRef): Promise<DraftHandle | undefined> {
    const rec = this.drafts.get(this.keyOf(draft));
    return Promise.resolve(rec ? toHandle(rec) : undefined);
  }

  submitForReview(draft: DraftRef, actor: Actor): Promise<DraftHandle> {
    return Promise.resolve(this.transition(draft, actor, "draft", "in_review", "submit"));
  }

  withdraw(draft: DraftRef, actor: Actor): Promise<DraftHandle> {
    return Promise.resolve(this.transition(draft, actor, "in_review", "draft", "withdraw"));
  }

  async publish(draft: DraftRef, actor: Actor): Promise<PublishResult> {
    const rec = this.requireDraft(draft);
    if (rec.status !== "in_review") {
      throw new Error(`Only an in_review draft can be published (clause is "${rec.status}")`);
    }
    const id = clauseId(rec.ref);
    // Two-pass, all-or-nothing: validate every locale row against the published set first, then write
    // them — so a mid-way immutability failure can't leave a version partially published.
    const clauses: Clause[] = [];
    for (const content of rec.rows.values()) {
      if (content.kind !== "clause") continue; // clause-only slice; rows are gated to clauses by asClause
      await this.assertNotPublished(id, rec.version, content.clause.locale);
      clauses.push(content.clause);
    }
    for (const clause of clauses) this.putClause(clause);
    this.drafts.delete(clauseKey(id, rec.version));
    this.record(actor, "publish", rec.ref, { version: rec.version }, "in_review", "published");
    return { ref: rec.ref, version: rec.version, locales: clauses.map((c) => c.locale).sort(), publishedAt: this.now() };
  }

  auditLog(filter?: { ref?: ElementRef; actorId?: string; since?: string }): Promise<AuditEntry[]> {
    const out = this.audit.filter(
      (e) =>
        (filter?.ref ? sameRef(e.element, filter.ref) : true) &&
        (filter?.actorId ? e.actor.id === filter.actorId : true) &&
        (filter?.since ? e.at >= filter.since : true),
    );
    return Promise.resolve(out);
  }

  // --- internals -------------------------------------------------------------

  private transition(
    draft: DraftRef,
    actor: Actor,
    from: DraftRecord["status"],
    to: DraftRecord["status"],
    action: AuditAction,
  ): DraftHandle {
    const rec = this.requireDraft(draft);
    if (rec.status !== from) throw new Error(`Cannot ${action} a "${rec.status}" draft (expected "${from}")`);
    rec.status = to;
    rec.updatedAt = this.now();
    rec.updatedBy = actor;
    this.record(actor, action, rec.ref, { version: rec.version }, from, to);
    return toHandle(rec);
  }

  private requireDraft(draft: DraftRef): DraftRecord {
    const rec = this.drafts.get(this.keyOf(draft));
    if (!rec) throw new Error(`No draft for ${describeRef(draft.ref)}${draft.version ? ` v${draft.version}` : ""}`);
    return rec;
  }

  private keyOf(draft: DraftRef): string {
    if (draft.ref.kind !== "clause") throw notSupported(draft.ref.kind);
    if (draft.version === undefined) throw new Error(`A clause DraftRef needs a version`);
    return clauseKey(draft.ref.id, draft.version);
  }

  /** Validate the ref+content are a clause (this slice) and their ids agree; returns the clause. */
  private asClause(ref: ElementRef, content: ElementContent): { clause: Clause; id: string } {
    if (ref.kind !== "clause") throw notSupported(ref.kind);
    if (content.kind !== "clause") throw new Error(`Content kind "${content.kind}" does not match clause ref`);
    if (content.clause.clause !== ref.id) {
      throw new Error(`Content clause id "${content.clause.clause}" does not match ref "${ref.id}"`);
    }
    return { clause: content.clause, id: ref.id };
  }

  private clauseDraftVersions(id: string): number[] {
    return [...this.drafts.values()].filter((r) => r.ref.kind === "clause" && r.ref.id === id).map((r) => r.version);
  }

  private async assertNotPublished(id: string, version: number, locale: string): Promise<void> {
    if ((await this.clauseLocales(id, version)).includes(locale)) {
      throw new Error(`Clause "${id}" v${version} (${locale}) is already published and immutable`);
    }
  }

  private record(
    actor: Actor,
    action: AuditAction,
    element: ElementRef,
    revision?: { version?: number; locale?: string },
    from?: ElementStatus,
    to?: ElementStatus,
  ): void {
    this.audit.push({
      id: String(++this.auditSeq).padStart(6, "0"),
      at: this.now(),
      actor,
      action,
      element,
      ...(revision ? { revision } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  }
}

// Keyed with NUL delimiters (see below) — a NUL cannot appear in a clause id, so keys never collide.
function clauseKey(id: string, version: number): string {
  return `clause ${id} ${version}`;
}

function clauseId(ref: ElementRef): string {
  if (ref.kind !== "clause") throw notSupported(ref.kind);
  return ref.id;
}

/** Ensure the stored content carries the allocated version. */
function withVersion(content: ElementContent, version: number): ElementContent {
  if (content.kind !== "clause" || content.clause.version === version) return content;
  return { kind: "clause", clause: { ...content.clause, version } };
}

function toHandle(rec: DraftRecord): DraftHandle {
  return {
    draft: { ref: rec.ref, version: rec.version },
    status: rec.status,
    content: [...rec.rows.values()],
    updatedAt: rec.updatedAt,
    updatedBy: rec.updatedBy,
  };
}

function sameRef(a: ElementRef, b: ElementRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "clause" || a.kind === "template" || a.kind === "include") return a.id === (b as typeof a).id;
  if (a.kind === "base") return a.family === (b as typeof a).family;
  return a.family === (b as typeof a).family && a.variant === (b as typeof a).variant;
}

function notSupported(kind: string): Error {
  return new Error(`Editing "${kind}" elements is not yet supported (Phase 7 slices #5/#6)`);
}
