import type { CatalogStore } from "./catalog-store";
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
import type { AuditEntry } from "./audit";
import type { ValidateOptions, ValidationFinding, ValidationResult } from "./validate";
import type { Clause } from "../core/clause";
import type { ClauseDiff } from "../core/clause-diff";
import { diffRichText } from "../core/clause-diff";
import { parseRichText } from "../core/rich-text";

/** Thrown when a draft fails the pre-publish integrity gate; carries the exact findings for a UI. */
export class PublishValidationError extends Error {
  constructor(public readonly findings: ValidationFinding[]) {
    super(`Cannot publish: ${findings.length} validation finding(s) — ${findings.map((f) => f.message).join("; ")}`);
    this.name = "PublishValidationError";
  }
}

/**
 * The runtime editing API surfaced as `catalog.editing` (ADR-0009). It wraps an
 * {@link EditableCatalogStore}: most operations pass through, but `publish` first runs the catalog's
 * integrity lint against a *draft-as-published overlay* (so a draft that would break a consuming
 * template is blocked), and `previewDiff` renders the old→new review diff.
 */
export interface EditingApi {
  createDraft(init: { ref: ElementRef; content: ElementContent; actor: Actor }): Promise<DraftHandle>;
  updateDraft(update: { draft: DraftRef; content: ElementContent; actor: Actor }): Promise<DraftHandle>;
  deleteDraft(draft: DraftRef, actor: Actor): Promise<void>;
  listDrafts(filter?: { kind?: ElementRef["kind"]; status?: ElementStatus }): Promise<DraftHandle[]>;
  loadDraft(draft: DraftRef): Promise<DraftHandle | undefined>;
  submitForReview(draft: DraftRef, actor: Actor): Promise<DraftHandle>;
  withdraw(draft: DraftRef, actor: Actor): Promise<DraftHandle>;
  /** Validate the catalog as if this draft were published; throws {@link PublishValidationError} on findings, else publishes. */
  publish(draft: DraftRef, actor: Actor, validateOptions?: ValidateOptions): Promise<PublishResult>;
  /** A review preview: the diff of a clause draft against the currently-published latest version. */
  previewDiff(draft: DraftRef, options?: { locale?: string }): Promise<ClauseDiff>;
  auditLog(filter?: { ref?: ElementRef; actorId?: string; since?: string }): Promise<AuditEntry[]>;
}

/** How the facade runs the integrity lint over an overlay store (injected to avoid a Catalog import cycle). */
type ValidateFn = (store: CatalogStore, options?: ValidateOptions) => Promise<ValidationResult>;

export function createEditingApi(store: EditableCatalogStore, validate: ValidateFn): EditingApi {
  return {
    createDraft: (init) => store.createDraft(init),
    updateDraft: (update) => store.updateDraft(update),
    deleteDraft: (draft, actor) => store.deleteDraft(draft, actor),
    listDrafts: (filter) => store.listDrafts(filter),
    loadDraft: (draft) => store.loadDraft(draft),
    submitForReview: (draft, actor) => store.submitForReview(draft, actor),
    withdraw: (draft, actor) => store.withdraw(draft, actor),
    auditLog: (filter) => store.auditLog(filter),

    publish: async (draft, actor, validateOptions) => {
      const handle = await store.loadDraft(draft);
      if (!handle) throw new Error(`No draft to publish for ${describeRef(draft.ref)}`);
      // Short-circuit a wrong-status publish: let the store raise its clear "only in_review" error
      // rather than spending a lint pass on a draft that can't publish anyway.
      if (handle.status !== "in_review") return store.publish(draft, actor);
      const result = await validate(draftPublishOverlay(store, handle), validateOptions);
      if (!result.ok) throw new PublishValidationError(result.findings);
      return store.publish(draft, actor);
    },

    previewDiff: async (draft, options) => {
      const handle = await store.loadDraft(draft);
      if (!handle) throw new Error(`No draft for ${describeRef(draft.ref)}`);
      return clausePreviewDiff(store, handle, options?.locale ?? "en");
    },
  };
}

/** A read store presenting `handle`'s draft content as published over `store`'s real published set. */
function draftPublishOverlay(store: EditableCatalogStore, handle: DraftHandle): CatalogStore {
  const ref = handle.draft.ref;
  // Every method delegates to the store; per-kind overrides below layer the draft in as "published".
  const base: CatalogStore = {
    templateIds: () => store.templateIds(),
    loadTemplate: (tid) => store.loadTemplate(tid),
    loadInclude: (iid) => store.loadInclude(iid),
    familyIds: () => store.familyIds(),
    variantIds: (family) => store.variantIds(family),
    loadBase: (family) => store.loadBase(family),
    loadVariant: (family, variant) => store.loadVariant(family, variant),
    clauseVersions: (cid) => store.clauseVersions(cid),
    clauseLocales: (cid, v) => store.clauseLocales(cid, v),
    loadClause: (cid, v, locale) => store.loadClause(cid, v, locale),
  };

  if (ref.kind === "clause") {
    const id = ref.id;
    const version = handle.draft.version ?? 0;
    const rows = clauseRows(handle);
    const locales = rows.map((r) => r.locale);
    return {
      ...base,
      clauseVersions: async (cid) => {
        const versions = await store.clauseVersions(cid);
        return cid === id ? [...new Set([...versions, version])].sort((a, b) => a - b) : versions;
      },
      clauseLocales: async (cid, v) => {
        const ls = await store.clauseLocales(cid, v);
        return cid === id && v === version ? [...new Set([...ls, ...locales])].sort() : ls;
      },
      loadClause: async (cid, v, locale) => {
        if (cid === id && v === version) {
          const exact = rows.find((r) => r.locale === locale);
          if (exact) return exact;
          // A new-version draft has no published rows yet, so mirror the store's in-version
          // sibling-locale fallback among the draft's OWN rows. (An additive draft on a published
          // version falls through to the store, which holds the published rows and its own fallback.)
          if (rows.length > 0 && (await store.clauseLocales(id, version)).length === 0) {
            return [...rows].sort((a, b) => a.locale.localeCompare(b.locale))[0]!;
          }
        }
        return store.loadClause(cid, v, locale);
      },
    };
  }

  if (ref.kind === "template") {
    const template = draftContent(handle, "template").template;
    return {
      ...base,
      loadTemplate: (tid) => (tid === ref.id ? Promise.resolve(template) : store.loadTemplate(tid)),
      templateIds: async () => [...new Set([...(await store.templateIds()), ref.id])].sort(),
    };
  }

  if (ref.kind === "include") {
    const include = draftContent(handle, "include").include;
    return { ...base, loadInclude: (iid) => (iid === ref.id ? Promise.resolve(include) : store.loadInclude(iid)) };
  }

  return base; // base/variant overlay lands with the variants slice (#6)
}

async function clausePreviewDiff(store: EditableCatalogStore, handle: DraftHandle, locale: string): Promise<ClauseDiff> {
  const ref = handle.draft.ref;
  if (ref.kind !== "clause") throw new Error(`previewDiff supports clause drafts only`);
  const version = handle.draft.version ?? 0;
  const newRow = clauseRows(handle).find((r) => r.locale === locale);
  const newText = newRow?.text ?? "";
  // Diff against the newest published version *below* this draft's — for an additive-translation draft
  // (same version number) that yields `from: 0`, i.e. an all-added new translation.
  const from = (await store.clauseVersions(ref.id)).filter((v) => v < version).at(-1) ?? 0;
  const oldText = from > 0 ? (await store.loadClause(ref.id, from, locale)).text : "";
  return {
    clause: ref.id,
    from,
    to: version,
    locale,
    changes: diffRichText(parseRichText(oldText), parseRichText(newText)),
  };
}

function clauseRows(handle: DraftHandle): Clause[] {
  return handle.content.filter((c): c is Extract<ElementContent, { kind: "clause" }> => c.kind === "clause").map((c) => c.clause);
}

/** The sole draft content payload of the given kind (single-revision drafts). */
function draftContent<K extends ElementContent["kind"]>(handle: DraftHandle, kind: K): Extract<ElementContent, { kind: K }> {
  const found = handle.content.find((c) => c.kind === kind);
  if (!found || found.kind !== kind) throw new Error(`Draft has no ${kind} content`);
  return found as Extract<ElementContent, { kind: K }>;
}
