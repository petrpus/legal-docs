import type { BaseTemplate, Include, Template, Variant } from "../core/template";
import type { Clause } from "../core/clause";
import type { CatalogStore } from "./catalog-store";
import { NotFoundError, type NotFoundKind, type NotFoundRef } from "../core/errors";

/** A family (a Base template + its Variants) in a memory seed. */
export interface MemoryFamily {
  base: BaseTemplate;
  variants?: Variant[];
}

/** Plain-object seed for a {@link MemoryCatalogStore}. Every element is optional. */
export interface MemoryCatalogSeed {
  templates?: Template[];
  includes?: Include[];
  families?: MemoryFamily[];
  /** Clauses, one object per (id, version, locale) row. */
  clauses?: Clause[];
}

/**
 * An in-memory {@link CatalogStore} seeded from plain objects — the read half of the editable
 * reference store (ADR-0009) and a fixtureless store for tests. It mirrors {@link FileCatalogStore}'s
 * read contract: `clauseVersions`/`clauseLocales` are ascending + distinct and return `[]` for an
 * unknown id; `loadClause` prefers the exact locale and falls back to another locale of the same
 * version (deterministically, the lowest-sorted); missing single elements throw. Duplicate seed rows
 * (same `(id,version,locale)`, or same family/template/include id) are last-write-wins.
 */
export class MemoryCatalogStore implements CatalogStore {
  private readonly templates = new Map<string, Template>();
  private readonly includes = new Map<string, Include>();
  private readonly bases = new Map<string, BaseTemplate>();
  private readonly variants = new Map<string, Map<string, Variant>>();
  /** clause id → version → locale → Clause. */
  private readonly clauses = new Map<string, Map<number, Map<string, Clause>>>();

  constructor(seed: MemoryCatalogSeed = {}) {
    for (const t of seed.templates ?? []) this.putTemplate(t);
    for (const i of seed.includes ?? []) this.putInclude(i);
    for (const f of seed.families ?? []) {
      this.putBase(f.base);
      for (const v of f.variants ?? []) this.putVariant(f.base.base, v);
    }
    for (const c of seed.clauses ?? []) this.putClause(c);
  }

  /**
   * Insert (or overwrite) one published clause locale row. `protected` so an editable subclass can
   * write a published row on publish (ADR-0009) — the sole way the published clause set grows.
   */
  protected putClause(c: Clause): void {
    const byVersion = this.clauses.get(c.clause) ?? new Map<number, Map<string, Clause>>();
    const byLocale = byVersion.get(c.version) ?? new Map<string, Clause>();
    byLocale.set(c.locale, c);
    byVersion.set(c.version, byLocale);
    this.clauses.set(c.clause, byVersion);
  }

  /** Insert (or overwrite) the published Template. `protected` so an editable subclass can publish. */
  protected putTemplate(t: Template): void {
    this.templates.set(t.template, t);
  }

  /** Insert (or overwrite) the published Include. `protected` so an editable subclass can publish. */
  protected putInclude(i: Include): void {
    this.includes.set(i.id, i);
  }

  /** Insert (or overwrite) the published Base template. `protected` so an editable subclass can publish. */
  protected putBase(b: BaseTemplate): void {
    this.bases.set(b.base, b);
  }

  /** Insert (or overwrite) a published Variant of a family. `protected` so an editable subclass can publish. */
  protected putVariant(family: string, v: Variant): void {
    const vs = this.variants.get(family) ?? new Map<string, Variant>();
    vs.set(v.variant, v);
    this.variants.set(family, vs);
  }

  templateIds(): Promise<string[]> {
    return Promise.resolve([...this.templates.keys()].sort());
  }

  loadTemplate(id: string): Promise<Template> {
    return this.require(this.templates.get(id), "template", { id });
  }

  clauseIds(): Promise<string[]> {
    return Promise.resolve([...this.clauses.keys()].sort());
  }

  includeIds(): Promise<string[]> {
    return Promise.resolve([...this.includes.keys()].sort());
  }

  loadInclude(id: string): Promise<Include> {
    return this.require(this.includes.get(id), "include", { id });
  }

  familyIds(): Promise<string[]> {
    return Promise.resolve([...this.bases.keys()].sort());
  }

  variantIds(family: string): Promise<string[]> {
    return Promise.resolve([...(this.variants.get(family)?.keys() ?? [])].sort());
  }

  loadBase(family: string): Promise<BaseTemplate> {
    return this.require(this.bases.get(family), "base", { family });
  }

  loadVariant(family: string, variant: string): Promise<Variant> {
    return this.require(this.variants.get(family)?.get(variant), "variant", { family, variant });
  }

  clauseVersions(id: string): Promise<number[]> {
    return Promise.resolve([...(this.clauses.get(id)?.keys() ?? [])].sort((a, b) => a - b));
  }

  clauseLocales(id: string, version: number): Promise<string[]> {
    return Promise.resolve([...(this.clauses.get(id)?.get(version)?.keys() ?? [])].sort());
  }

  loadClause(id: string, version: number, locale: string): Promise<Clause> {
    const byLocale = this.clauses.get(id)?.get(version);
    if (byLocale === undefined || byLocale.size === 0) {
      return Promise.reject(new NotFoundError("clause", { id, version }));
    }
    const exact = byLocale.get(locale);
    if (exact !== undefined) return Promise.resolve(exact);
    // Fall back to another authored locale of this version (deterministic: lowest-sorted).
    const fallbackLocale = [...byLocale.keys()].sort()[0]!;
    return Promise.resolve(byLocale.get(fallbackLocale)!);
  }

  private require<T>(value: T | undefined, kind: NotFoundKind, ref: NotFoundRef): Promise<T> {
    return value === undefined ? Promise.reject(new NotFoundError(kind, ref)) : Promise.resolve(value);
  }
}
