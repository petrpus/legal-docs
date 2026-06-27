import type { Template } from "../core/template";

/**
 * The persistence seam: how the Catalog loads authored content. The default implementation is
 * FileCatalogStore (files + Git); a future DB-backed editing API is another adapter of this same
 * interface. The walking skeleton only needs template loading; Clauses, Blocks and version listing
 * are added as later slices land.
 */
export interface CatalogStore {
  /** Ids of all templates available in the store. */
  templateIds(): Promise<string[]>;
  /** Load a single Template by id. */
  loadTemplate(id: string): Promise<Template>;
}
