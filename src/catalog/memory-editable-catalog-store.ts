import { MemoryCatalogStore } from "./memory-catalog-store";
import type {
  Actor,
  DraftHandle,
  DraftRef,
  EditableCatalogStore,
  ElementContent,
  ElementRef,
  ElementStatus,
  PublishResult,
} from "./editable-catalog-store";
import type { AuditEntry } from "./audit";
import { EditingWorkflow, type DraftRecord, type EditingBackend } from "./editing-workflow";

/** Options for {@link MemoryEditableCatalogStore} (injectable clock for deterministic tests). */
export interface MemoryEditableOptions {
  /** Timestamp source for `updatedAt` / audit `at`; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * The in-memory reference {@link EditableCatalogStore} (ADR-0009). All draft/status/allocation/audit
 * logic lives in {@link EditingWorkflow}; this class supplies the persistence primitives (a `Map` of
 * drafts + an audit array, published writes inherited from {@link MemoryCatalogStore}). The sqlite
 * adapter reuses the same {@link EditingWorkflow}, so the two stores stay behaviourally identical.
 * Drafts are invisible to `@latest` and every read method until published.
 */
export class MemoryEditableCatalogStore extends MemoryCatalogStore implements EditableCatalogStore {
  private readonly drafts = new Map<string, DraftRecord>();
  private readonly audit: AuditEntry[] = [];
  private auditSeq = 0;
  private readonly wf: EditingWorkflow;

  constructor(seed?: ConstructorParameters<typeof MemoryCatalogStore>[0], opts: MemoryEditableOptions = {}) {
    super(seed);
    const now = opts.now ?? (() => new Date().toISOString());
    // Arrow methods capture `this` lexically (the instance), so the backend reads/writes the store's
    // own maps and inherited (protected) `put*` writers.
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
      getDraftRecord: (key) => this.drafts.get(key),
      putDraftRecord: (key, rec) => void this.drafts.set(key, rec),
      deleteDraftRecord: (key) => void this.drafts.delete(key),
      listDraftRecords: () => [...this.drafts.values()],
      appendAudit: (entry) => void this.audit.push({ id: String(++this.auditSeq).padStart(6, "0"), ...entry }),
      listAudit: () => this.audit,
      transaction: (fn) => fn(), // synchronous single-threaded store — already effectively atomic
      now,
    };
    this.wf = new EditingWorkflow(backend);
  }

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
}
