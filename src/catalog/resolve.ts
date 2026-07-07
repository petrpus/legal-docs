import type { Clause } from "../core/clause";
import { parseClauseRef } from "../core/clause-ref";
import { composeTemplate } from "../core/compose";
import { NotFoundError } from "../core/errors";
import type { Template } from "../core/template";
import type { CatalogStore } from "./catalog-store";

/**
 * Template/Clause resolution against a bare `CatalogStore`, with no dependency on the `Catalog` class
 * or `FileCatalogStore`. Shared by `Catalog.getTemplate`/`getClause` (catalog.ts) and the browser-safe
 * entry (`src/browser.ts`, bundled without `node:fs`) — kept here once so the two paths cannot drift.
 */

/** Resolve a renderable Template: with no `variant`, a standalone Template; with one, the family's Base
 * + that Variant composed. */
export async function resolveTemplate(store: CatalogStore, id: string, variant?: string): Promise<Template> {
  if (variant === undefined) return store.loadTemplate(id);
  const [base, spec] = await Promise.all([store.loadBase(id), store.loadVariant(id, variant)]);
  return composeTemplate(base, spec);
}

/** Resolve a Clause reference (`id@vN` | `id@latest` | `id`) to a concrete Clause for a locale. */
export async function resolveClause(store: CatalogStore, ref: string, locale: string): Promise<Clause> {
  const { id, version } = parseClauseRef(ref);
  const concrete = version === "latest" ? await latestClauseVersion(store, id) : version;
  return store.loadClause(id, concrete, locale);
}

async function latestClauseVersion(store: CatalogStore, id: string): Promise<number> {
  const versions = await store.clauseVersions(id);
  const latest = versions.at(-1);
  if (latest === undefined) throw new NotFoundError("clause", { id });
  return latest;
}
