import { describe, it, expect } from "vitest";
import { Catalog } from "../src/catalog/catalog";
import { MemoryEditableCatalogStore } from "../src/catalog/memory-editable-catalog-store";
import type { Actor, ElementContent, ElementRef } from "../src/catalog/editable-catalog-store";
import type { Clause } from "../src/core/clause";

const actor: Actor = { id: "u1", name: "Editor" };
const noteRef: ElementRef = { kind: "clause", id: "note" };
const seedClause = (version: number, locale: string, text: string): Clause => ({ clause: "note", version, locale, vars: {}, text });
const content = (version: number, locale: string, text: string): ElementContent => ({ kind: "clause", clause: seedClause(version, locale, text) });

/** A store with `note` v1 (en) already published, and a fixed clock. */
const store = () =>
  new MemoryEditableCatalogStore({ clauses: [seedClause(1, "en", "v1 en")] }, { now: () => "2026-01-01T00:00:00Z" });

describe("MemoryEditableCatalogStore — clauses (ADR-0009)", () => {
  it("keeps a draft invisible to reads / @latest until published", async () => {
    const s = store();
    await s.createDraft({ ref: noteRef, content: content(2, "en", "v2"), actor });
    expect(await s.clauseVersions("note")).toEqual([1]);
    expect((await Catalog.fromStore(s).getClause("note@latest", "en")).version).toBe(1);
    expect(await s.listDrafts()).toHaveLength(1);
  });

  it("publishes draft → in_review → published, advancing @latest", async () => {
    const s = store();
    const h = await s.createDraft({ ref: noteRef, content: content(2, "en", "v2 en"), actor });
    expect(h).toMatchObject({ status: "draft", draft: { version: 2 } });
    await s.submitForReview(h.draft, actor);
    const pub = await s.publish(h.draft, actor);
    expect(pub).toMatchObject({ version: 2, locales: ["en"] });
    expect(await s.clauseVersions("note")).toEqual([1, 2]);
    expect((await Catalog.fromStore(s).getClause("note@latest", "en")).text).toBe("v2 en");
    expect(await s.listDrafts()).toHaveLength(0); // consumed on publish
  });

  it("only an in_review draft can be published; withdraw returns it to draft", async () => {
    const s = store();
    const h = await s.createDraft({ ref: noteRef, content: content(2, "en", "v2"), actor });
    await expect(s.publish(h.draft, actor)).rejects.toThrow(/Only an in_review draft/);
    await s.submitForReview(h.draft, actor);
    expect((await s.withdraw(h.draft, actor)).status).toBe("draft");
    await expect(s.publish(h.draft, actor)).rejects.toThrow(/Only an in_review draft/);
  });

  it("rejects drafting over an already-published (version, locale) row", async () => {
    const s = store();
    await expect(s.createDraft({ ref: noteRef, content: content(1, "en", "rewrite"), actor })).rejects.toThrow(
      /already published and immutable/,
    );
  });

  it("allows an additive translation to an existing published version", async () => {
    const s = store();
    const h = await s.createDraft({ ref: noteRef, content: content(1, "cs", "v1 cs"), actor });
    expect(h.draft.version).toBe(1); // additive onto the published v1, not a new version
    await s.submitForReview(h.draft, actor);
    await s.publish(h.draft, actor);
    expect(await s.clauseLocales("note", 1)).toEqual(["cs", "en"]);
    expect((await s.loadClause("note", 1, "cs")).text).toBe("v1 cs");
    expect((await s.loadClause("note", 1, "en")).text).toBe("v1 en"); // untouched
  });

  it("accumulates multiple locale rows on one draft via updateDraft, publishing them together", async () => {
    const s = store();
    const h = await s.createDraft({ ref: noteRef, content: content(2, "en", "v2 en"), actor });
    await s.updateDraft({ draft: h.draft, content: content(2, "cs", "v2 cs"), actor });
    expect(await s.loadDraft(h.draft)).toMatchObject({ content: [expect.anything(), expect.anything()] });
    await s.submitForReview(h.draft, actor);
    const pub = await s.publish(h.draft, actor);
    expect(pub.locales).toEqual(["cs", "en"]);
    expect(await s.clauseLocales("note", 2)).toEqual(["cs", "en"]);
  });

  it("deletes a draft and lists/filters drafts", async () => {
    const s = store();
    const h = await s.createDraft({ ref: noteRef, content: content(2, "en", "v2"), actor });
    expect(await s.listDrafts({ status: "draft" })).toHaveLength(1);
    expect(await s.listDrafts({ status: "in_review" })).toHaveLength(0);
    await s.deleteDraft(h.draft, actor);
    expect(await s.listDrafts()).toHaveLength(0);
    expect(await s.loadDraft(h.draft)).toBeUndefined();
  });

  it("records an audit entry per transition, filterable by actor", async () => {
    const s = store();
    const h = await s.createDraft({ ref: noteRef, content: content(2, "en", "v2"), actor });
    await s.submitForReview(h.draft, actor);
    await s.publish(h.draft, actor);
    const log = await s.auditLog();
    expect(log.map((e) => e.action)).toEqual(["create_draft", "submit", "publish"]);
    expect(log[2]).toMatchObject({ from: "in_review", to: "published", actor: { id: "u1" }, element: noteRef });
    expect(await s.auditLog({ actorId: "nobody" })).toEqual([]);
    expect(await s.auditLog({ ref: noteRef })).toHaveLength(3);
  });

  it("rejects editing a draft that is in review (must withdraw first)", async () => {
    const s = store();
    const h = await s.createDraft({ ref: noteRef, content: content(2, "en", "v2"), actor });
    await s.submitForReview(h.draft, actor);
    await expect(s.updateDraft({ draft: h.draft, content: content(2, "cs", "cs"), actor })).rejects.toThrow(
      /withdraw it first/,
    );
    // withdraw re-opens it for editing
    await s.withdraw(h.draft, actor);
    expect(await s.updateDraft({ draft: h.draft, content: content(2, "cs", "cs"), actor })).toBeDefined();
  });

  it("normalizes a bogus/non-sequential version to max+1", async () => {
    const s = store(); // v1 published
    const h = await s.createDraft({ ref: noteRef, content: content(99, "en", "x"), actor });
    expect(h.draft.version).toBe(2);
    expect(h.content[0]).toMatchObject({ clause: { version: 2 } });
  });

  it("rejects adding an already-published locale to an additive draft via updateDraft", async () => {
    const s = store(); // v1 en published
    const h = await s.createDraft({ ref: noteRef, content: content(1, "cs", "v1 cs"), actor }); // additive on v1
    await expect(s.updateDraft({ draft: h.draft, content: content(1, "en", "rewrite"), actor })).rejects.toThrow(
      /already published and immutable/,
    );
  });

  it("rejects editing a non-clause element in this slice", async () => {
    const s = store();
    const templateRef: ElementRef = { kind: "template", id: "doc" };
    await expect(
      s.createDraft({ ref: templateRef, content: { kind: "template", template: { template: "doc", version: 1, locale: "en", body: [] } }, actor }),
    ).rejects.toThrow(/not yet supported/);
  });
});
