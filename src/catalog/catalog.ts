import { FileCatalogStore } from "./file-catalog-store";
import type { CatalogStore } from "./catalog-store";
import {
  validateCatalog,
  type ValidateOptions,
  type ValidationResult,
} from "./validate";
import type { Include, Template } from "../core/template";
import type { Clause } from "../core/clause";
import { parseClauseRef } from "../core/clause-ref";

/**
 * The in-memory model of all authored content, loaded through a CatalogStore. The walking skeleton
 * exposes template loading; `validate()` and clause diffing arrive with later slices.
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

  getTemplate(id: string): Promise<Template> {
    return this.store.loadTemplate(id);
  }

  templateIds(): Promise<string[]> {
    return this.store.templateIds();
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

  private async latestVersion(id: string): Promise<number> {
    const versions = await this.store.clauseVersions(id);
    const latest = versions.at(-1);
    if (latest === undefined) throw new Error(`Clause "${id}" has no versions`);
    return latest;
  }

  /** Integrity lint: returns path-precise findings for unresolved refs, unregistered helpers, etc. */
  validate(options?: ValidateOptions): Promise<ValidationResult> {
    return validateCatalog(this, options);
  }
}
