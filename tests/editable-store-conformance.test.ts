import { describe, it, expect } from "vitest";
import { Catalog } from "../src/catalog/catalog";
import { MemoryEditableCatalogStore } from "../src/catalog/memory-editable-catalog-store";
import { SqliteEditableCatalogStore } from "../adapters/sqlite/sqlite-catalog-store";
import type { EditableCatalogStore } from "../src/catalog/editable-catalog-store";
import type { MemoryCatalogSeed } from "../src/catalog/memory-catalog-store";
import type { Clause } from "../src/core/clause";

const now = () => "2026-01-01T00:00:00Z";
const actor = { id: "u1", name: "Editor" };
const noteRef = { kind: "clause", id: "note" } as const;
const clause = (version: number, locale: string, text: string): Clause => ({ clause: "note", version, locale, vars: {}, text });
const cc = (version: number, locale: string, text: string) => ({ kind: "clause", clause: clause(version, locale, text) }) as const;

type MakeStore = (seed?: MemoryCatalogSeed) => EditableCatalogStore;

/**
 * The shared conformance contract every {@link EditableCatalogStore} must satisfy (ADR-0009). Run
 * against both the in-memory reference store and the sqlite adapter, guaranteeing behavioural parity.
 */
function runEditableStoreContract(name: string, make: MakeStore): void {
  describe(`EditableCatalogStore contract — ${name}`, () => {
    it("hides a clause draft until publish, then advances @latest", async () => {
      const s = make({ clauses: [clause(1, "en", "v1")] });
      const cat = Catalog.fromStore(s);
      const h = await s.createDraft({ ref: noteRef, content: cc(2, "en", "v2"), actor });
      expect(await s.clauseVersions("note")).toEqual([1]);
      await s.submitForReview(h.draft, actor);
      await s.publish(h.draft, actor);
      expect(await s.clauseVersions("note")).toEqual([1, 2]);
      expect((await cat.getClause("note@latest", "en")).text).toBe("v2");
    });

    it("rejects drafting over a published clause row", async () => {
      const s = make({ clauses: [clause(1, "en", "v1")] });
      await expect(s.createDraft({ ref: noteRef, content: cc(1, "en", "x"), actor })).rejects.toThrow(/immutable/);
    });

    it("allows an additive translation to a published version", async () => {
      const s = make({ clauses: [clause(1, "en", "en")] });
      const h = await s.createDraft({ ref: noteRef, content: cc(1, "cs", "cs"), actor });
      await s.submitForReview(h.draft, actor);
      await s.publish(h.draft, actor);
      expect(await s.clauseLocales("note", 1)).toEqual(["cs", "en"]);
    });

    it("bumps a template version on publish", async () => {
      const s = make({ templates: [{ template: "doc", version: 1, locale: "en", body: [{ paragraph: "v1" }] }] });
      const h = await s.createDraft({ ref: { kind: "template", id: "doc" }, content: { kind: "template", template: { template: "doc", version: 1, locale: "en", body: [{ paragraph: "v2" }] } }, actor });
      expect(h.draft.version).toBe(2);
      await s.submitForReview(h.draft, actor);
      await s.publish(h.draft, actor);
      expect((await s.loadTemplate("doc")).version).toBe(2);
    });

    it("publishes a versionless include", async () => {
      const s = make({});
      const h = await s.createDraft({ ref: { kind: "include", id: "foot" }, content: { kind: "include", include: { id: "foot", body: [{ paragraph: "f" }] } }, actor });
      await s.submitForReview(h.draft, actor);
      await s.publish(h.draft, actor);
      expect((await s.loadInclude("foot")).body).toEqual([{ paragraph: "f" }]);
    });

    it("composes a family with a published variant", async () => {
      const s = make({ families: [{ base: { base: "pledge", version: 1, locale: "en", body: [{ slot: "security" }] } }] });
      const cat = Catalog.fromStore(s);
      const variant = { variant: "two", extends: "pledge", overrides: { security: [{ paragraph: "sec" }] } };
      const h = await s.createDraft({ ref: { kind: "variant", family: "pledge", variant: "two" }, content: { kind: "variant", variant }, actor });
      await s.submitForReview(h.draft, actor);
      await s.publish(h.draft, actor);
      expect(await s.variantIds("pledge")).toEqual(["two"]);
      expect((await cat.getTemplate("pledge", "two")).body).toContainEqual({ paragraph: "sec" });
    });

    it("enforces the workflow (only in_review publishes) and audits every transition", async () => {
      const s = make({ clauses: [clause(1, "en", "v1")] });
      const h = await s.createDraft({ ref: noteRef, content: cc(2, "en", "v2"), actor });
      await expect(s.publish(h.draft, actor)).rejects.toThrow(/in_review/);
      await s.submitForReview(h.draft, actor);
      await s.publish(h.draft, actor);
      expect((await s.auditLog()).map((e) => e.action)).toEqual(["create_draft", "submit", "publish"]);
    });

    it("accumulates multiple locale rows in one clause draft and publishes them together", async () => {
      const s = make({});
      const h = await s.createDraft({ ref: noteRef, content: cc(1, "en", "en1"), actor });
      await s.updateDraft({ draft: h.draft, content: cc(1, "cs", "cs1"), actor });
      await s.submitForReview(h.draft, actor);
      const pub = await s.publish(h.draft, actor);
      expect(pub.locales).toEqual(["cs", "en"]);
      expect(await s.clauseLocales("note", 1)).toEqual(["cs", "en"]);
      expect((await s.loadClause("note", 1, "cs")).text).toBe("cs1");
    });

    it("round-trips a draft through updateDraft (persistence)", async () => {
      const s = make({});
      const tRef = { kind: "template", id: "g" } as const;
      const h = await s.createDraft({ ref: tRef, content: { kind: "template", template: { template: "g", version: 0, locale: "en", body: [{ paragraph: "a" }] } }, actor });
      await s.updateDraft({ draft: h.draft, content: { kind: "template", template: { template: "g", version: 0, locale: "en", body: [{ paragraph: "b" }] } }, actor });
      const loaded = await s.loadDraft(h.draft);
      expect(loaded?.content[0]).toMatchObject({ template: { body: [{ paragraph: "b" }] } });
    });
  });
}

runEditableStoreContract("memory", (seed) => new MemoryEditableCatalogStore(seed, { now }));
runEditableStoreContract("sqlite", (seed) => new SqliteEditableCatalogStore({ seed, now }));
