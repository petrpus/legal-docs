import type { BaseTemplate, Include, Template, Variant } from "../core/template";
import type { Clause } from "../core/clause";

/**
 * The persistence seam: how the Catalog loads authored content. The default implementation is
 * FileCatalogStore (files + Git); a future DB-backed editing API is another adapter of this same
 * interface.
 */
export interface CatalogStore {
  /** Ids of all templates available in the store. */
  templateIds(): Promise<string[]>;
  /** Load a single standalone Template by id. */
  loadTemplate(id: string): Promise<Template>;
  /** Load a shared Include (Partial) by id. */
  loadInclude(id: string): Promise<Include>;
  /** Ids of all Template families (groups of a Base template + Variants). */
  familyIds(): Promise<string[]>;
  /** Variant ids available in a family. */
  variantIds(family: string): Promise<string[]>;
  /** Load a family's Base template. */
  loadBase(family: string): Promise<BaseTemplate>;
  /** Load a single Variant of a family. */
  loadVariant(family: string, variant: string): Promise<Variant>;
  /** All versions of a Clause that exist, ascending. */
  clauseVersions(id: string): Promise<number[]>;
  /** The locales a Clause version is authored in (ascending). */
  clauseLocales(id: string, version: number): Promise<string[]>;
  /** Load a specific Clause version for a locale. */
  loadClause(id: string, version: number, locale: string): Promise<Clause>;
}
