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

/** The row key for a piece of draft content: a clause is keyed by locale; single-revision kinds by "". */
const SINGLE = "";

/** Internal draft record. A clause draft accumulates one content row per locale; others hold one row. */
interface DraftRecord {
  ref: ElementRef;
  version: number;
  status: Exclude<ElementStatus, "published">;
  rows: Map<string, ElementContent>;
  updatedAt: string;
  updatedBy: Actor;
}

/** Options for {@link MemoryEditableCatalogStore} (injectable clock for deterministic tests). */
export interface MemoryEditableOptions {
  /** Timestamp source for `updatedAt` / audit `at`; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * The in-memory reference {@link EditableCatalogStore} (ADR-0009). Implements the full
 * `draft → in_review → published` lifecycle for **clauses** (versions-as-rows, per-locale) and for
 * **templates / includes** (single-revision — publish swaps the newest published revision, bumping the
 * version for versioned kinds). **Variants/bases** land in a later slice and throw until then. Drafts
 * live outside the published set inherited from {@link MemoryCatalogStore}, so they are invisible to
 * `@latest` and every read method until published; `publish` is the sole writer, and every transition
 * is audited.
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
    const { ref, content, actor } = init;
    if (ref.kind === "clause") return this.createClauseDraft(ref, content, actor);
    if (ref.kind === "template") return this.createSingleDraft(ref, content, actor, await this.nextTemplateVersion(ref.id));
    if (ref.kind === "include") return this.createSingleDraft(ref, content, actor, 0);
    throw notSupported(ref.kind); // base/variant land in a later slice
  }

  async updateDraft(update: { draft: DraftRef; content: ElementContent; actor: Actor }): Promise<DraftHandle> {
    const rec = this.requireDraft(update.draft);
    // Content can only change while in `draft` — editing a submitted (`in_review`) draft would let the
    // published content differ from what was reviewed. Withdraw it first (ADR-0009 workflow).
    if (rec.status !== "draft") throw new Error(`Cannot edit a "${rec.status}" draft; withdraw it first`);
    if (rec.ref.kind === "clause") {
      const clause = this.asClause(rec.ref, update.content).clause;
      await this.assertNotPublished(rec.ref.id, rec.version, clause.locale);
      rec.rows.set(clause.locale, withVersion(update.content, rec.version));
      this.touch(rec, update.actor, { version: rec.version, locale: clause.locale });
      return toHandle(rec);
    }
    assertContentMatches(rec.ref, update.content);
    rec.rows.set(SINGLE, withVersion(update.content, rec.version));
    this.touch(rec, update.actor, rec.version > 0 ? { version: rec.version } : undefined);
    return toHandle(rec);
  }

  /** Discard a draft entirely. Allowed from either `draft` or `in_review` (rejecting = discarding). */
  async deleteDraft(draft: DraftRef, actor: Actor): Promise<void> {
    const rec = this.requireDraft(draft);
    this.drafts.delete(this.keyOf(draft));
    this.record(actor, "delete_draft", rec.ref, rec.version > 0 ? { version: rec.version } : undefined);
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
      throw new Error(`Only an in_review draft can be published (draft is "${rec.status}")`);
    }
    const ref = rec.ref;
    let locales: string[] | undefined;
    if (ref.kind === "clause") {
      // Two-pass, all-or-nothing: validate every locale row against the published set first, then write.
      const clauses: Clause[] = [];
      for (const content of rec.rows.values()) {
        if (content.kind !== "clause") continue;
        await this.assertNotPublished(ref.id, rec.version, content.clause.locale);
        clauses.push(content.clause);
      }
      for (const clause of clauses) this.putClause(clause);
      locales = clauses.map((c) => c.locale).sort();
    } else if (ref.kind === "template") {
      this.putTemplate(onlyContent(rec, "template").template);
    } else if (ref.kind === "include") {
      this.putInclude(onlyContent(rec, "include").include);
    } else {
      throw notSupported(ref.kind);
    }
    this.drafts.delete(this.keyOf(draft));
    this.record(actor, "publish", ref, rec.version > 0 ? { version: rec.version } : undefined, "in_review", "published");
    return { ref, version: rec.version, ...(locales ? { locales } : {}), publishedAt: this.now() };
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

  // --- create paths ----------------------------------------------------------

  private async createClauseDraft(ref: Extract<ElementRef, { kind: "clause" }>, content: ElementContent, actor: Actor): Promise<DraftHandle> {
    const { clause, id } = this.asClause(ref, content);
    const published = await this.clauseVersions(id);
    const draftVersions = this.clauseDraftVersions(id);
    // An existing *published* version → an additive-translation draft on it; otherwise a new version.
    const version = published.includes(clause.version) ? clause.version : Math.max(0, ...published, ...draftVersions) + 1;
    const key = clauseKey(id, version);
    if (this.drafts.has(key)) throw new Error(`A draft for clause "${id}" v${version} already exists; use updateDraft`);
    await this.assertNotPublished(id, version, clause.locale);
    const rec = this.newRecord(ref, version, clause.locale, withVersion(content, version), actor);
    this.record(actor, "create_draft", ref, { version, locale: clause.locale }, undefined, "draft");
    return toHandle(rec);
  }

  private createSingleDraft(ref: ElementRef, content: ElementContent, actor: Actor, version: number): DraftHandle {
    assertContentMatches(ref, content);
    const key = refKey(ref);
    if (this.drafts.has(key)) throw new Error(`A draft for ${describeRef(ref)} already exists; use updateDraft`);
    const rec = this.newRecord(ref, version, SINGLE, withVersion(content, version), actor);
    this.record(actor, "create_draft", ref, version > 0 ? { version } : undefined, undefined, "draft");
    return toHandle(rec);
  }

  private newRecord(ref: ElementRef, version: number, rowKey: string, content: ElementContent, actor: Actor): DraftRecord {
    const rec: DraftRecord = {
      ref,
      version,
      status: "draft",
      rows: new Map([[rowKey, content]]),
      updatedAt: this.now(),
      updatedBy: actor,
    };
    this.drafts.set(refKey(ref, version), rec);
    return rec;
  }

  // --- internals -------------------------------------------------------------

  private async nextTemplateVersion(id: string): Promise<number> {
    // Existence-check first (don't swallow load errors as "new element" — that would overwrite history).
    if (!(await this.templateIds()).includes(id)) return 1;
    return (await this.loadTemplate(id)).version + 1;
  }

  private transition(draft: DraftRef, actor: Actor, from: DraftRecord["status"], to: DraftRecord["status"], action: AuditAction): DraftHandle {
    const rec = this.requireDraft(draft);
    if (rec.status !== from) throw new Error(`Cannot ${action} a "${rec.status}" draft (expected "${from}")`);
    rec.status = to;
    this.touch(rec, actor);
    this.record(actor, action, rec.ref, rec.version > 0 ? { version: rec.version } : undefined, from, to);
    return toHandle(rec);
  }

  private touch(rec: DraftRecord, actor: Actor, revision?: { version?: number; locale?: string }): void {
    rec.updatedAt = this.now();
    rec.updatedBy = actor;
    if (revision !== undefined) this.record(actor, "update_draft", rec.ref, revision);
  }

  private requireDraft(draft: DraftRef): DraftRecord {
    const rec = this.drafts.get(this.keyOf(draft));
    if (!rec) throw new Error(`No draft for ${describeRef(draft.ref)}${draft.version ? ` v${draft.version}` : ""}`);
    return rec;
  }

  private keyOf(draft: DraftRef): string {
    if (draft.ref.kind === "clause" && draft.version === undefined) throw new Error(`A clause DraftRef needs a version`);
    if (draft.ref.kind === "base" || draft.ref.kind === "variant") throw notSupported(draft.ref.kind);
    return refKey(draft.ref, draft.version);
  }

  private asClause(ref: ElementRef, content: ElementContent): { clause: Clause; id: string } {
    if (ref.kind !== "clause") throw notSupported(ref.kind);
    if (content.kind !== "clause") throw new Error(`Content kind "${content.kind}" does not match clause ref`);
    if (content.clause.clause !== ref.id) throw new Error(`Content clause id "${content.clause.clause}" does not match ref "${ref.id}"`);
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

/** The draft-map key. Clauses key by (id, version) — many version drafts; other kinds one per element. */
function refKey(ref: ElementRef, version?: number): string {
  switch (ref.kind) {
    case "clause":
      return clauseKey(ref.id, version ?? 0);
    case "template":
      return `template\0${ref.id}`;
    case "include":
      return `include\0${ref.id}`;
    case "base":
      return `base\0${ref.family}`;
    case "variant":
      return `variant\0${ref.family}\0${ref.variant}`;
  }
}

// NUL delimiter — cannot appear in a clause id, so the key never collides regardless of the id text.
function clauseKey(id: string, version: number): string {
  return `clause\0${id}\0${version}`;
}

/** Set the allocated version onto versioned content (clause/template); versionless kinds pass through. */
function withVersion(content: ElementContent, version: number): ElementContent {
  if (content.kind === "clause") {
    return content.clause.version === version ? content : { kind: "clause", clause: { ...content.clause, version } };
  }
  if (content.kind === "template") {
    return content.template.version === version ? content : { kind: "template", template: { ...content.template, version } };
  }
  return content;
}

/** Validate that a single-revision content payload matches its ref (kind + id). */
function assertContentMatches(ref: ElementRef, content: ElementContent): void {
  if (ref.kind === "template") {
    if (content.kind !== "template") throw new Error(`Content kind "${content.kind}" does not match template ref`);
    if (content.template.template !== ref.id) throw new Error(`Content template id "${content.template.template}" does not match ref "${ref.id}"`);
    return;
  }
  if (ref.kind === "include") {
    if (content.kind !== "include") throw new Error(`Content kind "${content.kind}" does not match include ref`);
    if (content.include.id !== ref.id) throw new Error(`Content include id "${content.include.id}" does not match ref "${ref.id}"`);
    return;
  }
  throw notSupported(ref.kind);
}

/** Read the sole content of a single-revision draft, narrowed to the expected kind. */
function onlyContent<K extends ElementContent["kind"]>(rec: DraftRecord, kind: K): Extract<ElementContent, { kind: K }> {
  const content = rec.rows.get(SINGLE);
  if (!content || content.kind !== kind) throw new Error(`Draft for ${describeRef(rec.ref)} has no ${kind} content`);
  return content as Extract<ElementContent, { kind: K }>;
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
  return new Error(`Editing "${kind}" elements is not yet supported (Phase 7 slice #6)`);
}
