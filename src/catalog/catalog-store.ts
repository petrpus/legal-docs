import type { Template } from "../core/template";
import type { Clause } from "../core/clause";

/**
 * The persistence seam: how the Catalog loads authored content. The default implementation is
 * FileCatalogStore (files + Git); a future DB-backed editing API is another adapter of this same
 * interface.
 */
export interface CatalogStore {
  /** Ids of all templates available in the store. */
  templateIds(): Promise<string[]>;
  /** Load a single Template by id. */
  loadTemplate(id: string): Promise<Template>;
  /** All versions of a Clause that exist, ascending. */
  clauseVersions(id: string): Promise<number[]>;
  /** Load a specific Clause version for a locale. */
  loadClause(id: string, version: number, locale: string): Promise<Clause>;
}
