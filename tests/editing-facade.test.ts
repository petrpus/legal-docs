import { describe, it, expect } from "vitest";
import { Catalog } from "../src/catalog/catalog";
import { MemoryCatalogStore } from "../src/catalog/memory-catalog-store";
import { MemoryEditableCatalogStore } from "../src/catalog/memory-editable-catalog-store";
import { PublishValidationError } from "../src/catalog/editing-facade";
import type { Actor, ElementContent, ElementRef } from "../src/catalog/editable-catalog-store";
import type { Clause } from "../src/core/clause";
import type { Template } from "../src/core/template";

const actor: Actor = { id: "u1", name: "Editor" };
const noteRef: ElementRef = { kind: "clause", id: "note" };

const clause = (version: number, locale: string, vars: Clause["vars"], text: string): Clause => ({ clause: "note", version, locale, vars, text });
const content = (version: number, locale: string, vars: Clause["vars"], text: string): ElementContent => ({ kind: "clause", clause: clause(version, locale, vars, text) });

// A template that maps a payload slice into the clause's `greeting` var via `note@latest`.
const doc: Template = { template: "doc", version: 1, locale: "en", body: [{ clause: "note@latest", vars: { greeting: "$g" } }] };
const editable = () =>
  new MemoryEditableCatalogStore(
    { templates: [doc], clauses: [clause(1, "en", { greeting: { type: "string" } }, "Hello {{greeting}}")] },
    { now: () => "2026-01-01T00:00:00Z" },
  );

describe("catalog.editing — publish gate (ADR-0009)", () => {
  it("blocks publishing a draft that would break a consuming template", async () => {
    const store = editable();
    const cat = Catalog.fromStore(store);
    // v2 renames the var → the template's `greeting` mapping becomes unknown + `salutation` unmet.
    const h = await cat.editing.createDraft({ ref: noteRef, content: content(2, "en", { salutation: { type: "string" } }, "Hi {{salutation}}"), actor });
    await cat.editing.submitForReview(h.draft, actor);

    await expect(cat.editing.publish(h.draft, actor)).rejects.toBeInstanceOf(PublishValidationError);
    // The gate blocked it → nothing published, @latest still v1.
    expect(await store.clauseVersions("note")).toEqual([1]);
    try {
      await cat.editing.publish(h.draft, actor);
    } catch (e) {
      expect((e as PublishValidationError).findings.length).toBeGreaterThan(0);
    }
  });

  it("does not over-block a new-version en-only draft consumed by a cs-locale template", async () => {
    // The template resolves note@latest in its own locale (cs); post-publish the store falls back to the
    // draft's en row. The overlay must mirror that fallback so the gate doesn't wrongly block.
    const docCs: Template = { template: "doccs", version: 1, locale: "cs", body: [{ clause: "note@latest", vars: { greeting: "$g" } }] };
    const store = new MemoryEditableCatalogStore(
      { templates: [docCs], clauses: [clause(1, "en", { greeting: { type: "string" } }, "Hi {{greeting}}")] },
      { now: () => "2026-01-01T00:00:00Z" },
    );
    const cat = Catalog.fromStore(store);
    const h = await cat.editing.createDraft({ ref: noteRef, content: content(2, "en", { greeting: { type: "string" } }, "Hi2 {{greeting}}"), actor });
    await cat.editing.submitForReview(h.draft, actor);
    await expect(cat.editing.publish(h.draft, actor)).resolves.toMatchObject({ version: 2 });
  });

  it("publishes a clean draft through the gate, advancing @latest", async () => {
    const store = editable();
    const cat = Catalog.fromStore(store);
    const h = await cat.editing.createDraft({ ref: noteRef, content: content(2, "en", { greeting: { type: "string" } }, "Hi again {{greeting}}"), actor });
    await cat.editing.submitForReview(h.draft, actor);
    const pub = await cat.editing.publish(h.draft, actor);
    expect(pub).toMatchObject({ version: 2 });
    expect((await cat.getClause("note@latest", "en")).text).toBe("Hi again {{greeting}}");
    // The freshly-published catalog is itself clean.
    expect((await cat.validate()).ok).toBe(true);
  });
});

describe("catalog.editing — template publish gate", () => {
  const tRef: ElementRef = { kind: "template", id: "doc" };
  const templateContent = (body: Template["body"]): ElementContent => ({ kind: "template", template: { template: "doc", version: 0, locale: "en", body } });

  it("blocks publishing a template draft that references a missing clause", async () => {
    const store = new MemoryEditableCatalogStore({}, { now: () => "2026-01-01T00:00:00Z" });
    const cat = Catalog.fromStore(store);
    const h = await cat.editing.createDraft({ ref: tRef, content: templateContent([{ clause: "ghost@latest" }]), actor });
    await cat.editing.submitForReview(h.draft, actor);
    await expect(cat.editing.publish(h.draft, actor)).rejects.toBeInstanceOf(PublishValidationError);
    expect(await store.templateIds()).toEqual([]); // nothing published
  });

  it("publishes a clean template draft through the gate", async () => {
    const store = new MemoryEditableCatalogStore({}, { now: () => "2026-01-01T00:00:00Z" });
    const cat = Catalog.fromStore(store);
    const h = await cat.editing.createDraft({ ref: tRef, content: templateContent([{ paragraph: "hi" }]), actor });
    await cat.editing.submitForReview(h.draft, actor);
    await expect(cat.editing.publish(h.draft, actor)).resolves.toMatchObject({ version: 1 });
    expect(await store.templateIds()).toEqual(["doc"]);
  });
});

describe("catalog.editing — review + access", () => {
  it("previews the diff of a draft against the published latest", async () => {
    const store = new MemoryEditableCatalogStore(
      { clauses: [clause(1, "en", {}, "Original wording.")] },
      { now: () => "2026-01-01T00:00:00Z" },
    );
    const cat = Catalog.fromStore(store);
    const h = await cat.editing.createDraft({ ref: noteRef, content: content(2, "en", {}, "Revised wording."), actor });
    const diff = await cat.editing.previewDiff(h.draft);
    expect(diff).toMatchObject({ clause: "note", from: 1, to: 2, locale: "en" });
    expect(diff.changes.length).toBeGreaterThan(0);
  });

  it("exposes editable operations and audit through the facade", async () => {
    const store = editable();
    const cat = Catalog.fromStore(store);
    await cat.editing.createDraft({ ref: noteRef, content: content(2, "en", { greeting: { type: "string" } }, "x {{greeting}}"), actor });
    expect(await cat.editing.listDrafts({ status: "draft" })).toHaveLength(1);
    expect((await cat.editing.auditLog()).map((e) => e.action)).toEqual(["create_draft"]);
  });

  it("throws when the store is not editable", () => {
    const cat = Catalog.fromStore(new MemoryCatalogStore());
    expect(() => cat.editing).toThrow(/not editable/);
  });
});
