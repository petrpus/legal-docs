import { FileCatalogStore } from "./file-catalog-store";
import type { CatalogStore } from "./catalog-store";
import type { Template } from "../core/template";

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
}
