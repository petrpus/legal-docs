import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { Catalog } from "../src/catalog/catalog";
import { FileCatalogStore } from "../src/catalog/file-catalog-store";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "..", "legal-docs");

/**
 * `Catalog.fromStore(store)` is the DI seam a DB-backed editable store plugs into (ADR-0009). It had
 * zero test coverage; here we pin that a Catalog built over a `FileCatalogStore` via `fromStore`
 * behaves identically to one built via `fromDir`. Today both wrap `FileCatalogStore`, so this is an
 * end-to-end smoke of the seam; its full parity-oracle value lands once it becomes the shared
 * conformance suite run against the in-memory / sqlite stores (ADR-0009 §Consequences).
 */
describe("Catalog.fromStore parity with fromDir", () => {
  const viaDir = () => Catalog.fromDir(catalogDir);
  const viaStore = () => Catalog.fromStore(new FileCatalogStore(catalogDir));

  it("resolves the same template ids and families", async () => {
    const a = await viaDir();
    const b = viaStore();
    expect(await b.templateIds()).toEqual(await a.templateIds());
    expect(await b.familyIds()).toEqual(await a.familyIds());
  });

  it("enumerates the same clauses, includes, and clause versions", async () => {
    const a = await viaDir();
    const b = viaStore();
    expect(await b.clauseIds()).toEqual(await a.clauseIds());
    expect(await a.clauseIds()).toContain("counterparts"); // the sample catalog has it
    expect(await b.includeIds()).toEqual(await a.includeIds());
    expect(await b.clauseVersions("counterparts")).toEqual(await a.clauseVersions("counterparts"));
  });

  it("resolves the same standalone template", async () => {
    const a = await viaDir();
    const b = viaStore();
    expect(await b.getTemplate("parties")).toEqual(await a.getTemplate("parties"));
  });

  it("composes the same variant", async () => {
    const a = await viaDir();
    const b = viaStore();
    expect(await b.getTemplate("pledge-agreement", "two-party")).toEqual(
      await a.getTemplate("pledge-agreement", "two-party"),
    );
  });

  it("resolves @latest to the same concrete clause", async () => {
    const store = new FileCatalogStore(catalogDir);
    const a = await viaDir();
    const b = Catalog.fromStore(store);
    const [ca, cb] = [await a.getClause("counterparts@latest", "en"), await b.getClause("counterparts@latest", "en")];
    expect(cb).toEqual(ca);
    // @latest must land on the highest existing version (published, per ADR-0009).
    const versions = await store.clauseVersions("counterparts");
    expect(cb.version).toBe(versions.at(-1));
  });

  it("produces the same clause diff", async () => {
    const a = await viaDir();
    const b = viaStore();
    const opts = { from: 1, to: 2 };
    expect(await b.clauses.diff("counterparts", opts)).toEqual(await a.clauses.diff("counterparts", opts));
  });

  it("produces the same validation result", async () => {
    const a = await viaDir();
    const b = viaStore();
    expect(await b.validate()).toEqual(await a.validate());
  });
});
