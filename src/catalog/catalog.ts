import { FileCatalogStore } from "./file-catalog-store";
import type { CatalogStore } from "./catalog-store";
import { isEditableStore } from "./editable-catalog-store";
import { createEditingApi, type EditingApi } from "./editing-facade";
import {
  validateCatalog,
  type ValidateOptions,
  type ValidationResult,
} from "./validate";
import type { Include, Template } from "../core/template";
import type { Clause } from "../core/clause";
import { parseClauseRef } from "../core/clause-ref";
import { LegalDocsError, NotFoundError } from "../core/errors";
import { composeTemplate } from "../core/compose";
import { parseRichText } from "../core/rich-text";
import { diffRichText, type ClauseDiff } from "../core/clause-diff";

/** Options for a Clause version diff. */
export interface ClauseDiffOptions {
  from: number;
  to: number;
  /** Locale of the versions to compare (defaults to `en`). */
  locale?: string;
}

/**
 * The in-memory model of all authored content (Templates, families/Variants, Clauses, Includes),
 * loaded through a CatalogStore. Exposes template/variant resolution, `validate()` (integrity lint)
 * and `clauses.diff(...)`.
 */
export class Catalog {
  private constructor(private readonly store: CatalogStore) {}

  /** Load a file-based catalog from a directory (uses FileCatalogStore). */
  static async fromDir(dir: string): Promise<Catalog> {
    return new Catalog(new FileCatalogStore(dir));
  }

  /** Build a Catalog over any CatalogStore (the seam for future DB-backed stores). */
  static fromStore(store: CatalogStore): Catalog {
    return new Catalog(store);
  }

  /**
   * Resolve a renderable Template. With no `variant`, loads a standalone Template; with a `variant`,
   * composes the family's Base template + that Variant into a concrete Template (Slots filled).
   */
  getTemplate(id: string, variant?: string): Promise<Template> {
    if (variant === undefined) return this.store.loadTemplate(id);
    return this.composeVariant(id, variant);
  }

  private async composeVariant(family: string, variant: string): Promise<Template> {
    const [base, spec] = await Promise.all([
      this.store.loadBase(family),
      this.store.loadVariant(family, variant),
    ]);
    return composeTemplate(base, spec);
  }

  templateIds(): Promise<string[]> {
    return this.store.templateIds();
  }

  /** Ids of all Template families (a Base template + its Variants). */
  familyIds(): Promise<string[]> {
    return this.store.familyIds();
  }

  /** Variant ids available in a family. */
  variantIds(family: string): Promise<string[]> {
    return this.store.variantIds(family);
  }

  /** Ids of all Clauses in the catalog (ascending). */
  clauseIds(): Promise<string[]> {
    return this.store.clauseIds();
  }

  /** Ids of all shared Includes (ascending). */
  includeIds(): Promise<string[]> {
    return this.store.includeIds();
  }

  /** The published versions of a Clause (ascending). */
  clauseVersions(id: string): Promise<number[]> {
    return this.store.clauseVersions(id);
  }

  /** Load a shared Include (Partial) by id. */
  loadInclude(id: string): Promise<Include> {
    return this.store.loadInclude(id);
  }

  /** Resolve a Clause reference (`id@vN` | `id@latest` | `id`) to a concrete Clause for a locale. */
  async getClause(ref: string, locale: string): Promise<Clause> {
    const { id, version } = parseClauseRef(ref);
    const concrete = version === "latest" ? await this.latestVersion(id) : version;
    return this.store.loadClause(id, concrete, locale);
  }

  private clausesApi?: { diff: (id: string, options: ClauseDiffOptions) => Promise<ClauseDiff> };

  /** Clause-level operations (currently version diffing). A stable object across accesses. */
  get clauses(): { diff: (id: string, options: ClauseDiffOptions) => Promise<ClauseDiff> } {
    return (this.clausesApi ??= { diff: (id, options) => this.diffClause(id, options) });
  }

  private async diffClause(id: string, options: ClauseDiffOptions): Promise<ClauseDiff> {
    const locale = options.locale ?? "en";
    const [from, to] = await Promise.all([
      this.clauseVersion(id, options.from, locale),
      this.clauseVersion(id, options.to, locale),
    ]);
    return {
      clause: id,
      from: options.from,
      to: options.to,
      locale,
      changes: diffRichText(parseRichText(from.text), parseRichText(to.text)),
    };
  }

  private async clauseVersion(id: string, version: number, locale: string): Promise<Clause> {
    try {
      return await this.store.loadClause(id, version, locale);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new LegalDocsError(`Cannot diff clause "${id}" v${version} (${locale}): ${reason}`, { cause });
    }
  }

  /** The locales a Clause version is authored in. */
  clauseLocales(id: string, version: number): Promise<string[]> {
    return this.store.clauseLocales(id, version);
  }

  private async latestVersion(id: string): Promise<number> {
    const versions = await this.store.clauseVersions(id);
    const latest = versions.at(-1);
    if (latest === undefined) throw new NotFoundError("clause", { id });
    return latest;
  }

  /** Integrity lint: returns path-precise findings for unresolved refs, unregistered helpers, etc. */
  validate(options?: ValidateOptions): Promise<ValidationResult> {
    return validateCatalog(this, options);
  }

  private editingApi?: EditingApi;

  /**
   * The runtime editing API (ADR-0009) — drafting, the draft→in_review→published workflow, a
   * validate()-gated publish, and review diffs. Available only when the underlying store is editable
   * (implements `EditableCatalogStore`); throws otherwise. A stable object across accesses.
   */
  get editing(): EditingApi {
    if (!isEditableStore(this.store)) {
      throw new LegalDocsError("This Catalog's store is not editable — build it over an EditableCatalogStore (e.g. MemoryEditableCatalogStore)");
    }
    const store = this.store;
    return (this.editingApi ??= createEditingApi(store, (overlay, options) => Catalog.fromStore(overlay).validate(options)));
  }
}
