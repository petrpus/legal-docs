import { DatabaseSync } from "node:sqlite";
import type {
  Actor,
  DraftHandle,
  DraftRef,
  EditableCatalogStore,
  ElementContent,
  ElementRef,
  ElementStatus,
  PublishResult,
} from "../../src/catalog/editable-catalog-store";
import type { AuditEntry } from "../../src/catalog/audit";
import { NotFoundError, type NotFoundKind, type NotFoundRef } from "../../src/core/errors";
import { EditingWorkflow, type DraftRecord, type EditingBackend } from "../../src/catalog/editing-workflow";
import type { MemoryCatalogSeed } from "../../src/catalog/memory-catalog-store";
import type { Clause } from "../../src/core/clause";
import type { BaseTemplate, Include, Template, Variant } from "../../src/core/template";

export interface SqliteStoreOptions {
  /** An existing DatabaseSync, or a file location (":memory:" by default). */
  db?: DatabaseSync;
  location?: string;
  /** Initial *published* content. */
  seed?: MemoryCatalogSeed;
  /** Timestamp source for audit/updatedAt; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * A node:sqlite-backed {@link EditableCatalogStore} (ADR-0009). It reuses the shared
 * {@link EditingWorkflow} — this class only maps the persistence primitives (published rows, drafts,
 * audit) onto SQL — so its behaviour is identical to the in-memory reference store (a shared
 * conformance suite pins that). Uses Node's built-in synchronous SQLite; no native dependency.
 */
export class SqliteEditableCatalogStore implements EditableCatalogStore {
  private readonly db: DatabaseSync;
  private readonly wf: EditingWorkflow;

  constructor(opts: SqliteStoreOptions = {}) {
    this.db = opts.db ?? new DatabaseSync(opts.location ?? ":memory:");
    migrate(this.db);
    for (const t of opts.seed?.templates ?? []) this.putTemplate(t);
    for (const i of opts.seed?.includes ?? []) this.putInclude(i);
    for (const f of opts.seed?.families ?? []) {
      this.putBase(f.base);
      for (const v of f.variants ?? []) this.putVariant(f.base.base, v);
    }
    for (const c of opts.seed?.clauses ?? []) this.putClause(c);

    const now = opts.now ?? (() => new Date().toISOString());
    // Arrow methods capture `this` lexically (the instance).
    const backend: EditingBackend = {
      templateIds: () => this.templateIds(),
      loadTemplate: (id) => this.loadTemplate(id),
      clauseIds: () => this.clauseIds(),
      includeIds: () => this.includeIds(),
      loadInclude: (id) => this.loadInclude(id),
      familyIds: () => this.familyIds(),
      variantIds: (family) => this.variantIds(family),
      loadBase: (family) => this.loadBase(family),
      loadVariant: (family, variant) => this.loadVariant(family, variant),
      clauseVersions: (id) => this.clauseVersions(id),
      clauseLocales: (id, version) => this.clauseLocales(id, version),
      loadClause: (id, version, locale) => this.loadClause(id, version, locale),
      putClause: (c) => this.putClause(c),
      putTemplate: (t) => this.putTemplate(t),
      putInclude: (i) => this.putInclude(i),
      putBase: (b) => this.putBase(b),
      putVariant: (family, v) => this.putVariant(family, v),
      getDraftRecord: (key) => this.getDraftRecord(key),
      putDraftRecord: (key, rec) => this.putDraftRecord(key, rec),
      deleteDraftRecord: (key) => this.deleteDraftRecord(key),
      listDraftRecords: () => this.listDraftRecords(),
      appendAudit: (entry) => this.appendAudit(entry),
      listAudit: () => this.listAudit(),
      transaction: (fn) => this.transaction(fn),
      now,
    };
    this.wf = new EditingWorkflow(backend);
  }

  // --- CatalogStore reads (published only) -----------------------------------
  // `ORDER BY` uses SQLite's default BINARY (UTF-8) collation; the memory store sorts via JS
  // (UTF-16). These agree for the ASCII locale codes / slug ids the catalog uses by convention.

  templateIds(): Promise<string[]> {
    return Promise.resolve(this.col<string>("SELECT DISTINCT cid AS v FROM published WHERE kind='template' ORDER BY cid"));
  }
  familyIds(): Promise<string[]> {
    return Promise.resolve(this.col<string>("SELECT DISTINCT cid AS v FROM published WHERE kind='base' ORDER BY cid"));
  }
  variantIds(family: string): Promise<string[]> {
    return Promise.resolve(this.col<string>("SELECT variant AS v FROM published WHERE kind='variant' AND cid=? ORDER BY variant", family));
  }
  clauseIds(): Promise<string[]> {
    return Promise.resolve(this.col<string>("SELECT DISTINCT cid AS v FROM published WHERE kind='clause' ORDER BY cid"));
  }
  includeIds(): Promise<string[]> {
    return Promise.resolve(this.col<string>("SELECT DISTINCT cid AS v FROM published WHERE kind='include' ORDER BY cid"));
  }
  clauseVersions(id: string): Promise<number[]> {
    return Promise.resolve(this.col<number>("SELECT DISTINCT version AS v FROM published WHERE kind='clause' AND cid=? ORDER BY version", id));
  }
  clauseLocales(id: string, version: number): Promise<string[]> {
    return Promise.resolve(this.col<string>("SELECT locale AS v FROM published WHERE kind='clause' AND cid=? AND version=? ORDER BY locale", id, version));
  }

  loadTemplate(id: string): Promise<Template> {
    return this.loadJson<Template>("SELECT json FROM published WHERE kind='template' AND cid=? ORDER BY version DESC LIMIT 1", "template", { id }, id);
  }
  loadInclude(id: string): Promise<Include> {
    return this.loadJson<Include>("SELECT json FROM published WHERE kind='include' AND cid=? LIMIT 1", "include", { id }, id);
  }
  loadBase(family: string): Promise<BaseTemplate> {
    return this.loadJson<BaseTemplate>("SELECT json FROM published WHERE kind='base' AND cid=? ORDER BY version DESC LIMIT 1", "base", { family }, family);
  }
  loadVariant(family: string, variant: string): Promise<Variant> {
    return this.loadJson<Variant>("SELECT json FROM published WHERE kind='variant' AND cid=? AND variant=? LIMIT 1", "variant", { family, variant }, family, variant);
  }
  loadClause(id: string, version: number, locale: string): Promise<Clause> {
    const exact = this.get("SELECT json FROM published WHERE kind='clause' AND cid=? AND version=? AND locale=?", id, version, locale);
    if (exact) return Promise.resolve(JSON.parse(exact.json) as Clause);
    // Fall back to the lowest-sorted authored locale of this version (mirrors the file/memory stores).
    const fallback = this.get("SELECT json FROM published WHERE kind='clause' AND cid=? AND version=? ORDER BY locale LIMIT 1", id, version);
    if (fallback) return Promise.resolve(JSON.parse(fallback.json) as Clause);
    return Promise.reject(new NotFoundError("clause", { id, version }));
  }

  // --- EditableCatalogStore (delegate to the shared workflow) ----------------

  createDraft(init: { ref: ElementRef; content: ElementContent; actor: Actor }): Promise<DraftHandle> {
    return this.wf.createDraft(init);
  }
  updateDraft(update: { draft: DraftRef; content: ElementContent; actor: Actor }): Promise<DraftHandle> {
    return this.wf.updateDraft(update);
  }
  deleteDraft(draft: DraftRef, actor: Actor): Promise<void> {
    return this.wf.deleteDraft(draft, actor);
  }
  listDrafts(filter?: { kind?: ElementRef["kind"]; status?: ElementStatus }): Promise<DraftHandle[]> {
    return this.wf.listDrafts(filter);
  }
  loadDraft(draft: DraftRef): Promise<DraftHandle | undefined> {
    return this.wf.loadDraft(draft);
  }
  submitForReview(draft: DraftRef, actor: Actor): Promise<DraftHandle> {
    return this.wf.submitForReview(draft, actor);
  }
  withdraw(draft: DraftRef, actor: Actor): Promise<DraftHandle> {
    return this.wf.withdraw(draft, actor);
  }
  publish(draft: DraftRef, actor: Actor): Promise<PublishResult> {
    return this.wf.publish(draft, actor);
  }
  auditLog(filter?: { ref?: ElementRef; actorId?: string; since?: string }): Promise<AuditEntry[]> {
    return this.wf.auditLog(filter);
  }

  // --- persistence primitives (published writes) -----------------------------

  private putClause(c: Clause): void {
    this.upsertPublished("clause", c.clause, "", c.version, c.locale, c);
  }
  private putTemplate(t: Template): void {
    this.upsertPublished("template", t.template, "", t.version, "", t);
  }
  private putInclude(i: Include): void {
    this.upsertPublished("include", i.id, "", 0, "", i);
  }
  private putBase(b: BaseTemplate): void {
    this.upsertPublished("base", b.base, "", b.version, "", b);
  }
  private putVariant(family: string, v: Variant): void {
    this.upsertPublished("variant", family, v.variant, 0, "", v);
  }
  private upsertPublished(kind: string, cid: string, variant: string, version: number, locale: string, value: unknown): void {
    this.db
      .prepare("INSERT OR REPLACE INTO published (kind, cid, variant, version, locale, json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(kind, cid, variant, version, locale, JSON.stringify(value));
  }

  // --- persistence primitives (drafts) ---------------------------------------

  private getDraftRecord(key: string): DraftRecord | undefined {
    const row = this.get("SELECT json FROM draft WHERE key=?", key);
    return row ? deserializeDraft(row.json) : undefined;
  }
  private putDraftRecord(key: string, rec: DraftRecord): void {
    this.db.prepare("INSERT OR REPLACE INTO draft (key, json) VALUES (?, ?)").run(key, serializeDraft(rec));
  }
  private deleteDraftRecord(key: string): void {
    this.db.prepare("DELETE FROM draft WHERE key=?").run(key);
  }
  private listDraftRecords(): DraftRecord[] {
    return (this.db.prepare("SELECT json FROM draft").all() as { json: string }[]).map((r) => deserializeDraft(r.json));
  }

  // --- persistence primitives (audit) ----------------------------------------

  private appendAudit(entry: Omit<AuditEntry, "id">): void {
    this.db.prepare("INSERT INTO audit (json) VALUES (?)").run(JSON.stringify(entry));
  }

  /** Run a publish's synchronous writes atomically — commit on success, roll back on any throw. */
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private listAudit(): AuditEntry[] {
    return (this.db.prepare("SELECT seq, json FROM audit ORDER BY seq").all() as { seq: number; json: string }[]).map((r) => ({
      id: String(r.seq).padStart(6, "0"),
      ...(JSON.parse(r.json) as Omit<AuditEntry, "id">),
    }));
  }

  // --- tiny query helpers ----------------------------------------------------

  private col<T>(sql: string, ...params: (string | number)[]): T[] {
    return (this.db.prepare(sql).all(...params) as { v: T }[]).map((r) => r.v);
  }
  private get(sql: string, ...params: (string | number)[]): { json: string } | undefined {
    return this.db.prepare(sql).get(...params) as { json: string } | undefined;
  }
  private loadJson<T>(sql: string, kind: NotFoundKind, ref: NotFoundRef, ...params: (string | number)[]): Promise<T> {
    const row = this.get(sql, ...params);
    return row ? Promise.resolve(JSON.parse(row.json) as T) : Promise.reject(new NotFoundError(kind, ref));
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS published (
      kind TEXT NOT NULL, cid TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 0, locale TEXT NOT NULL DEFAULT '', json TEXT NOT NULL,
      PRIMARY KEY (kind, cid, variant, version, locale)
    );
    CREATE TABLE IF NOT EXISTS draft (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
  `);
}

function serializeDraft(rec: DraftRecord): string {
  return JSON.stringify({ ref: rec.ref, version: rec.version, status: rec.status, rows: [...rec.rows.entries()], updatedAt: rec.updatedAt, updatedBy: rec.updatedBy });
}
function deserializeDraft(json: string): DraftRecord {
  const o = JSON.parse(json) as Omit<DraftRecord, "rows"> & { rows: [string, ElementContent][] };
  return { ref: o.ref, version: o.version, status: o.status, rows: new Map(o.rows), updatedAt: o.updatedAt, updatedBy: o.updatedBy };
}
