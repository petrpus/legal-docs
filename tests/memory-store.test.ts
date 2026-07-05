import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { Catalog } from "../src/catalog/catalog";
import { FileCatalogStore } from "../src/catalog/file-catalog-store";
import { MemoryCatalogStore, type MemoryCatalogSeed } from "../src/catalog/memory-catalog-store";
import type { Clause } from "../src/core/clause";
import type { BaseTemplate, Include, Template, Variant } from "../src/core/template";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const tmpl = (id: string): Template => ({ template: id, version: 1, locale: "en", body: [{ paragraph: id }] });
const clause = (id: string, version: number, locale: string): Clause => ({ clause: id, version, locale, vars: {}, text: `${id} v${version} ${locale}` });
const include = (id: string): Include => ({ id, body: [{ paragraph: id }] });
const base = (family: string): BaseTemplate => ({ base: family, version: 1, locale: "en", body: [{ slot: "s" }] });
const variant = (family: string, name: string): Variant => ({ variant: name, extends: family, overrides: { s: [{ paragraph: name }] } });

describe("MemoryCatalogStore (read)", () => {
  it("returns template & family ids sorted", async () => {
    const store = new MemoryCatalogStore({
      templates: [tmpl("b"), tmpl("a")],
      families: [{ base: base("g"), variants: [variant("g", "y"), variant("g", "x")] }],
    });
    expect(await store.templateIds()).toEqual(["a", "b"]);
    expect(await store.familyIds()).toEqual(["g"]);
    expect(await store.variantIds("g")).toEqual(["x", "y"]);
  });

  it("loads standalone/base/variant/include, throwing on a miss", async () => {
    const store = new MemoryCatalogStore({
      templates: [tmpl("a")],
      includes: [include("part")],
      families: [{ base: base("g"), variants: [variant("g", "x")] }],
    });
    expect(await store.loadTemplate("a")).toEqual(tmpl("a"));
    expect(await store.loadInclude("part")).toEqual(include("part"));
    expect(await store.loadBase("g")).toEqual(base("g"));
    expect(await store.loadVariant("g", "x")).toEqual(variant("g", "x"));
    await expect(store.loadTemplate("nope")).rejects.toThrow(/Template "nope" not found/);
    await expect(store.loadVariant("g", "nope")).rejects.toThrow(/Variant "nope"/);
  });

  it("reports clause versions/locales ascending & distinct; [] for an unknown id", async () => {
    const store = new MemoryCatalogStore({
      clauses: [clause("note", 2, "en"), clause("note", 1, "en"), clause("note", 1, "cs")],
    });
    expect(await store.clauseVersions("note")).toEqual([1, 2]);
    expect(await store.clauseLocales("note", 1)).toEqual(["cs", "en"]);
    expect(await store.clauseVersions("ghost")).toEqual([]);
    expect(await store.clauseLocales("note", 9)).toEqual([]);
  });

  it("loads the exact locale, falls back to another locale of the version, throws on a missing version", async () => {
    const store = new MemoryCatalogStore({ clauses: [clause("note", 1, "en"), clause("note", 1, "cs")] });
    expect(await store.loadClause("note", 1, "en")).toEqual(clause("note", 1, "en"));
    // "de" is absent → fall back to the lowest-sorted authored locale ("cs").
    expect(await store.loadClause("note", 1, "de")).toEqual(clause("note", 1, "cs"));
    await expect(store.loadClause("note", 9, "en")).rejects.toThrow(/Clause "note" v9 not found/);
  });
});

describe("MemoryCatalogStore parity with FileCatalogStore", () => {
  // Round-trip: load known elements from a file fixture into a memory seed, then assert both stores —
  // driven through the same Catalog facade — resolve identically. Proves the memory store is a faithful
  // CatalogStore (the reference every editable/DB store is held to via the shared conformance suite).
  // The `loadClause` locale-fallback path is intentionally NOT part of parity: FileStore falls back in
  // fs/readdir order while memory falls back to the lowest-sorted locale — a deliberate divergence
  // (covered by the direct tests above), not an oversight.
  it("resolves a template + versioned clause identically (snapshot-v2 fixture)", async () => {
    const dir = path.join(fixtures, "snapshot-v2");
    const file = new FileCatalogStore(dir);
    const seed: MemoryCatalogSeed = {
      templates: [await file.loadTemplate("doc")],
      clauses: [await file.loadClause("note", 1, "en"), await file.loadClause("note", 2, "en")],
    };
    const viaFile = Catalog.fromStore(file);
    const viaMem = Catalog.fromStore(new MemoryCatalogStore(seed));

    expect(await viaMem.templateIds()).toEqual(await viaFile.templateIds());
    expect(await viaMem.getTemplate("doc")).toEqual(await viaFile.getTemplate("doc"));
    expect(await viaMem.getClause("note@latest", "en")).toEqual(await viaFile.getClause("note@latest", "en"));
    expect(await viaMem.clauses.diff("note", { from: 1, to: 2 })).toEqual(await viaFile.clauses.diff("note", { from: 1, to: 2 }));
  });

  it("composes a family variant identically (family fixture)", async () => {
    const dir = path.join(fixtures, "family");
    const file = new FileCatalogStore(dir);
    const seed: MemoryCatalogSeed = {
      families: [{ base: await file.loadBase("greet"), variants: [await file.loadVariant("greet", "two-party")] }],
    };
    const viaFile = Catalog.fromStore(file);
    const viaMem = Catalog.fromStore(new MemoryCatalogStore(seed));
    expect(await viaMem.getTemplate("greet", "two-party")).toEqual(await viaFile.getTemplate("greet", "two-party"));
  });
});
