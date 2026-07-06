import type { Clause } from "../core/clause";
import type { BaseTemplate, Include, Template, Variant } from "../core/template";
import type { CatalogStore } from "./catalog-store";
import {
  describeRef,
  type Actor,
  type DraftHandle,
  type DraftRef,
  type ElementContent,
  type ElementRef,
  type ElementStatus,
  type PublishResult,
} from "./editable-catalog-store";
import type { AuditAction, AuditEntry } from "./audit";
import { LegalDocsError, NotFoundError, type NotFoundRef } from "../core/errors";

/** The row key for draft content: a clause keys by locale; single-revision kinds by "". */
const SINGLE = "";

/** Internal draft record. A clause draft accumulates one content row per locale; others hold one row. */
export interface DraftRecord {
  ref: ElementRef;
  version: number;
  status: Exclude<ElementStatus, "published">;
  rows: Map<string, ElementContent>;
  updatedAt: string;
  updatedBy: Actor;
}

/**
 * The persistence primitives the editing workflow needs, on top of the read `CatalogStore`. Both the
 * in-memory reference store and the sqlite adapter implement this; {@link EditingWorkflow} holds all the
 * status/allocation/immutability/audit logic so the two backends stay behaviourally identical (the
 * shared conformance suite is run against both). Read methods are async (from `CatalogStore`); the
 * write primitives are synchronous (both Map and node:sqlite are synchronous).
 */
export interface EditingBackend extends CatalogStore {
  putClause(c: Clause): void;
  putTemplate(t: Template): void;
  putInclude(i: Include): void;
  putBase(b: BaseTemplate): void;
  putVariant(family: string, v: Variant): void;

  getDraftRecord(key: string): DraftRecord | undefined;
  putDraftRecord(key: string, rec: DraftRecord): void;
  deleteDraftRecord(key: string): void;
  listDraftRecords(): DraftRecord[];

  appendAudit(entry: Omit<AuditEntry, "id">): void;
  listAudit(): AuditEntry[];

  /** Run the (synchronous) mutations of a publish atomically. A DB backend wraps them in a transaction. */
  transaction<T>(fn: () => T): T;

  now(): string;
}

/** The shared editing logic (ADR-0009), parameterized over a persistence {@link EditingBackend}. */
export class EditingWorkflow {
  constructor(private readonly b: EditingBackend) {}

  async createDraft(init: { ref: ElementRef; content: ElementContent; actor: Actor }): Promise<DraftHandle> {
    const { ref, content, actor } = init;
    if (ref.kind === "clause") return this.createClauseDraft(ref, content, actor);
    if (ref.kind === "template") return this.createSingleDraft(ref, content, actor, await this.nextTemplateVersion(ref.id));
    if (ref.kind === "base") return this.createSingleDraft(ref, content, actor, await this.nextBaseVersion(ref.family));
    return this.createSingleDraft(ref, content, actor, 0); // include / variant — versionless
  }

  async updateDraft(update: { draft: DraftRef; content: ElementContent; actor: Actor }): Promise<DraftHandle> {
    const rec = this.requireDraft(update.draft);
    if (rec.status !== "draft") throw new LegalDocsError(`Cannot edit a "${rec.status}" draft; withdraw it first`);
    if (rec.ref.kind === "clause") {
      const clause = asClause(rec.ref, update.content);
      await this.assertNotPublished(rec.ref.id, rec.version, clause.locale);
      rec.rows.set(clause.locale, withVersion(update.content, rec.version));
      return this.save(rec, update.actor, { version: rec.version, locale: clause.locale });
    }
    assertContentMatches(rec.ref, update.content);
    rec.rows.set(SINGLE, withVersion(update.content, rec.version));
    return this.save(rec, update.actor, rec.version > 0 ? { version: rec.version } : undefined);
  }

  async deleteDraft(draft: DraftRef, actor: Actor): Promise<void> {
    const rec = this.requireDraft(draft);
    this.b.deleteDraftRecord(this.keyOf(draft));
    this.record(actor, "delete_draft", rec.ref, rec.version > 0 ? { version: rec.version } : undefined);
  }

  async listDrafts(filter?: { kind?: ElementRef["kind"]; status?: ElementStatus }): Promise<DraftHandle[]> {
    return this.b
      .listDraftRecords()
      .filter((r) => (filter?.kind ? r.ref.kind === filter.kind : true))
      .filter((r) => (filter?.status ? r.status === filter.status : true))
      .map(toHandle);
  }

  async loadDraft(draft: DraftRef): Promise<DraftHandle | undefined> {
    const rec = this.b.getDraftRecord(this.keyOf(draft));
    return rec ? toHandle(rec) : undefined;
  }

  async submitForReview(draft: DraftRef, actor: Actor): Promise<DraftHandle> {
    return this.transition(draft, actor, "draft", "in_review", "submit");
  }

  async withdraw(draft: DraftRef, actor: Actor): Promise<DraftHandle> {
    return this.transition(draft, actor, "in_review", "draft", "withdraw");
  }

  async publish(draft: DraftRef, actor: Actor): Promise<PublishResult> {
    const rec = this.requireDraft(draft);
    if (rec.status !== "in_review") throw new LegalDocsError(`Only an in_review draft can be published (draft is "${rec.status}")`);
    const ref = rec.ref;
    // Phase 1 — validate the draft against the published set (async reads; no writes yet).
    let writePublished: () => void;
    let locales: string[] | undefined;
    if (ref.kind === "clause") {
      // Two-pass, all-or-nothing: validate every locale row first, then write them together.
      const clauses: Clause[] = [];
      for (const content of rec.rows.values()) {
        if (content.kind !== "clause") continue;
        await this.assertNotPublished(ref.id, rec.version, content.clause.locale);
        clauses.push(content.clause);
      }
      locales = clauses.map((c) => c.locale).sort();
      writePublished = () => clauses.forEach((c) => this.b.putClause(c));
    } else if (ref.kind === "template") {
      const template = onlyContent(rec, "template").template;
      writePublished = () => this.b.putTemplate(template);
    } else if (ref.kind === "include") {
      const include = onlyContent(rec, "include").include;
      writePublished = () => this.b.putInclude(include);
    } else if (ref.kind === "base") {
      const base = onlyContent(rec, "base").base;
      writePublished = () => this.b.putBase(base);
    } else {
      // A variant only makes sense against a published base (an orphan variant is un-composable).
      if (!(await this.b.familyIds()).includes(ref.family)) {
        throw new LegalDocsError(`Cannot publish variant "${ref.variant}": family "${ref.family}" has no published base`);
      }
      const variant = onlyContent(rec, "variant").variant;
      writePublished = () => this.b.putVariant(ref.family, variant);
    }
    // Phase 2 — atomic write: publish the row(s), consume the draft, and audit in one transaction.
    this.b.transaction(() => {
      writePublished();
      this.b.deleteDraftRecord(this.keyOf(draft));
      this.record(actor, "publish", ref, rec.version > 0 ? { version: rec.version } : undefined, "in_review", "published");
    });
    return { ref, version: rec.version, ...(locales ? { locales } : {}), publishedAt: this.b.now() };
  }

  async auditLog(filter?: { ref?: ElementRef; actorId?: string; since?: string }): Promise<AuditEntry[]> {
    return this.b
      .listAudit()
      .filter(
        (e) =>
          (filter?.ref ? sameRef(e.element, filter.ref) : true) &&
          (filter?.actorId ? e.actor.id === filter.actorId : true) &&
          (filter?.since ? e.at >= filter.since : true),
      );
  }

  // --- internals -------------------------------------------------------------

  private async createClauseDraft(ref: Extract<ElementRef, { kind: "clause" }>, content: ElementContent, actor: Actor): Promise<DraftHandle> {
    const clause = asClause(ref, content);
    const id = ref.id;
    const published = await this.b.clauseVersions(id);
    const draftVersions = this.clauseDraftVersions(id);
    const version = published.includes(clause.version) ? clause.version : Math.max(0, ...published, ...draftVersions) + 1;
    const key = clauseKey(id, version);
    if (this.b.getDraftRecord(key)) throw new LegalDocsError(`A draft for clause "${id}" v${version} already exists; use updateDraft`);
    await this.assertNotPublished(id, version, clause.locale);
    const rec = this.newRecord(ref, version, clause.locale, withVersion(content, version), actor);
    this.record(actor, "create_draft", ref, { version, locale: clause.locale }, undefined, "draft");
    return toHandle(rec);
  }

  private createSingleDraft(ref: Exclude<ElementRef, { kind: "clause" }>, content: ElementContent, actor: Actor, version: number): DraftHandle {
    assertContentMatches(ref, content);
    if (this.b.getDraftRecord(refKey(ref))) throw new LegalDocsError(`A draft for ${describeRef(ref)} already exists; use updateDraft`);
    const rec = this.newRecord(ref, version, SINGLE, withVersion(content, version), actor);
    this.record(actor, "create_draft", ref, version > 0 ? { version } : undefined, undefined, "draft");
    return toHandle(rec);
  }

  private newRecord(ref: ElementRef, version: number, rowKey: string, content: ElementContent, actor: Actor): DraftRecord {
    const rec: DraftRecord = { ref, version, status: "draft", rows: new Map([[rowKey, content]]), updatedAt: this.b.now(), updatedBy: actor };
    this.b.putDraftRecord(refKey(ref, version), rec);
    return rec;
  }

  private async nextTemplateVersion(id: string): Promise<number> {
    if (!(await this.b.templateIds()).includes(id)) return 1;
    return (await this.b.loadTemplate(id)).version + 1;
  }

  private async nextBaseVersion(family: string): Promise<number> {
    if (!(await this.b.familyIds()).includes(family)) return 1;
    return (await this.b.loadBase(family)).version + 1;
  }

  private transition(draft: DraftRef, actor: Actor, from: DraftRecord["status"], to: DraftRecord["status"], action: AuditAction): DraftHandle {
    const rec = this.requireDraft(draft);
    if (rec.status !== from) throw new LegalDocsError(`Cannot ${action} a "${rec.status}" draft (expected "${from}")`);
    rec.status = to;
    rec.updatedAt = this.b.now();
    rec.updatedBy = actor;
    this.b.putDraftRecord(this.keyOf(draft), rec);
    this.record(actor, action, rec.ref, rec.version > 0 ? { version: rec.version } : undefined, from, to);
    return toHandle(rec);
  }

  private save(rec: DraftRecord, actor: Actor, revision?: { version?: number; locale?: string }): DraftHandle {
    rec.updatedAt = this.b.now();
    rec.updatedBy = actor;
    this.b.putDraftRecord(refKey(rec.ref, rec.version), rec);
    if (revision !== undefined) this.record(actor, "update_draft", rec.ref, revision);
    return toHandle(rec);
  }

  private requireDraft(draft: DraftRef): DraftRecord {
    const rec = this.b.getDraftRecord(this.keyOf(draft));
    if (!rec) throw new NotFoundError("draft", refToNotFound(draft.ref, draft.version), `No draft for ${describeRef(draft.ref)}${draft.version ? ` v${draft.version}` : ""}`);
    return rec;
  }

  private keyOf(draft: DraftRef): string {
    if (draft.ref.kind === "clause" && draft.version === undefined) throw new LegalDocsError(`A clause DraftRef needs a version`);
    return refKey(draft.ref, draft.version);
  }

  private clauseDraftVersions(id: string): number[] {
    return this.b.listDraftRecords().filter((r) => r.ref.kind === "clause" && r.ref.id === id).map((r) => r.version);
  }

  private async assertNotPublished(id: string, version: number, locale: string): Promise<void> {
    if ((await this.b.clauseLocales(id, version)).includes(locale)) {
      throw new LegalDocsError(`Clause "${id}" v${version} (${locale}) is already published and immutable`);
    }
  }

  private record(actor: Actor, action: AuditAction, element: ElementRef, revision?: { version?: number; locale?: string }, from?: ElementStatus, to?: ElementStatus): void {
    this.b.appendAudit({
      at: this.b.now(),
      actor,
      action,
      element,
      ...(revision ? { revision } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  }
}

// --- pure helpers ------------------------------------------------------------

/** Map an element ref (+ optional version) to a structured {@link NotFoundRef} for a NotFoundError. */
export function refToNotFound(ref: ElementRef, version?: number): NotFoundRef {
  const base = ref.kind === "base" || ref.kind === "variant" ? { family: ref.family } : { id: ref.id };
  return {
    ...base,
    ...(ref.kind === "variant" ? { variant: ref.variant } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

/** The draft-map key. Clauses key by (id, version) — many version drafts; other kinds one per element. */
export function refKey(ref: ElementRef, version?: number): string {
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

function clauseKey(id: string, version: number): string {
  return `clause\0${id}\0${version}`;
}

function asClause(ref: Extract<ElementRef, { kind: "clause" }>, content: ElementContent): Clause {
  if (content.kind !== "clause") throw new LegalDocsError(`Content kind "${content.kind}" does not match clause ref`);
  if (content.clause.clause !== ref.id) throw new LegalDocsError(`Content clause id "${content.clause.clause}" does not match ref "${ref.id}"`);
  return content.clause;
}

/** Set the allocated version onto versioned content (clause/template/base); versionless kinds pass through. */
function withVersion(content: ElementContent, version: number): ElementContent {
  if (content.kind === "clause") return content.clause.version === version ? content : { kind: "clause", clause: { ...content.clause, version } };
  if (content.kind === "template") return content.template.version === version ? content : { kind: "template", template: { ...content.template, version } };
  if (content.kind === "base") return content.base.version === version ? content : { kind: "base", base: { ...content.base, version } };
  return content;
}

function assertContentMatches(ref: Exclude<ElementRef, { kind: "clause" }>, content: ElementContent): void {
  if (ref.kind === "template") {
    if (content.kind !== "template") throw new LegalDocsError(`Content kind "${content.kind}" does not match template ref`);
    if (content.template.template !== ref.id) throw new LegalDocsError(`Content template id "${content.template.template}" does not match ref "${ref.id}"`);
    return;
  }
  if (ref.kind === "include") {
    if (content.kind !== "include") throw new LegalDocsError(`Content kind "${content.kind}" does not match include ref`);
    if (content.include.id !== ref.id) throw new LegalDocsError(`Content include id "${content.include.id}" does not match ref "${ref.id}"`);
    return;
  }
  if (ref.kind === "base") {
    if (content.kind !== "base") throw new LegalDocsError(`Content kind "${content.kind}" does not match base ref`);
    if (content.base.base !== ref.family) throw new LegalDocsError(`Content base family "${content.base.base}" does not match ref "${ref.family}"`);
    return;
  }
  if (content.kind !== "variant") throw new LegalDocsError(`Content kind "${content.kind}" does not match variant ref`);
  if (content.variant.variant !== ref.variant) throw new LegalDocsError(`Content variant "${content.variant.variant}" does not match ref "${ref.variant}"`);
}

function onlyContent<K extends ElementContent["kind"]>(rec: DraftRecord, kind: K): Extract<ElementContent, { kind: K }> {
  const content = rec.rows.get(SINGLE);
  if (!content || content.kind !== kind) throw new LegalDocsError(`Draft for ${describeRef(rec.ref)} has no ${kind} content`);
  return content as Extract<ElementContent, { kind: K }>;
}

export function toHandle(rec: DraftRecord): DraftHandle {
  return { draft: { ref: rec.ref, version: rec.version }, status: rec.status, content: [...rec.rows.values()], updatedAt: rec.updatedAt, updatedBy: rec.updatedBy };
}

function sameRef(a: ElementRef, b: ElementRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "clause" || a.kind === "template" || a.kind === "include") return a.id === (b as typeof a).id;
  if (a.kind === "base") return a.family === (b as typeof a).family;
  return a.family === (b as typeof a).family && a.variant === (b as typeof a).variant;
}
