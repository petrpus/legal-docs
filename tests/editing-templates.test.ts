import { describe, it, expect } from "vitest";
import { MemoryEditableCatalogStore } from "../src/catalog/memory-editable-catalog-store";
import type { Actor, ElementContent, ElementRef } from "../src/catalog/editable-catalog-store";
import type { BodyItem, Include, Template } from "../src/core/template";

const actor: Actor = { id: "u1", name: "Editor" };
const now = () => "2026-01-01T00:00:00Z";

const tmpl = (id: string, version: number, body: BodyItem[]): Template => ({ template: id, version, locale: "en", body });
const templateContent = (id: string, version: number, body: BodyItem[]): ElementContent => ({ kind: "template", template: tmpl(id, version, body) });
const includeContent = (id: string, body: BodyItem[]): ElementContent => ({ kind: "include", include: { id, body } as Include });

const tRef = (id: string): ElementRef => ({ kind: "template", id });
const iRef = (id: string): ElementRef => ({ kind: "include", id });

describe("MemoryEditableCatalogStore — templates & includes (ADR-0009)", () => {
  it("keeps a new template draft invisible until published, then allocates version 1", async () => {
    const s = new MemoryEditableCatalogStore({}, { now });
    const h = await s.createDraft({ ref: tRef("greeting"), content: templateContent("greeting", 0, [{ paragraph: "hi" }]), actor });
    expect(h.draft.version).toBe(1);
    expect(await s.templateIds()).toEqual([]); // hidden
    await s.submitForReview(h.draft, actor);
    const pub = await s.publish(h.draft, actor);
    expect(pub).toMatchObject({ version: 1 });
    expect(await s.templateIds()).toEqual(["greeting"]);
    expect((await s.loadTemplate("greeting")).version).toBe(1);
  });

  it("bumps the version when publishing an edit to an existing template", async () => {
    const s = new MemoryEditableCatalogStore({ templates: [tmpl("greeting", 1, [{ paragraph: "v1" }])] }, { now });
    const h = await s.createDraft({ ref: tRef("greeting"), content: templateContent("greeting", 1, [{ paragraph: "v2" }]), actor });
    expect(h.draft.version).toBe(2); // next revision
    await s.submitForReview(h.draft, actor);
    await s.publish(h.draft, actor);
    const published = await s.loadTemplate("greeting");
    expect(published.version).toBe(2);
    expect(published.body).toEqual([{ paragraph: "v2" }]);
  });

  it("replaces a template draft's content via updateDraft, one draft per id", async () => {
    const s = new MemoryEditableCatalogStore({}, { now });
    const h = await s.createDraft({ ref: tRef("g"), content: templateContent("g", 0, [{ paragraph: "a" }]), actor });
    await s.updateDraft({ draft: h.draft, content: templateContent("g", 0, [{ paragraph: "b" }]), actor });
    expect((await s.loadDraft(h.draft))?.content[0]).toMatchObject({ template: { body: [{ paragraph: "b" }] } });
    await expect(s.createDraft({ ref: tRef("g"), content: templateContent("g", 0, []), actor })).rejects.toThrow(/already exists/);
  });

  it("drafts and publishes a versionless include", async () => {
    const s = new MemoryEditableCatalogStore({}, { now });
    const h = await s.createDraft({ ref: iRef("footer"), content: includeContent("footer", [{ paragraph: "foot" }]), actor });
    expect(h.draft.version).toBe(0); // includes carry no version
    await expect(s.loadInclude("footer")).rejects.toThrow(); // hidden until published
    await s.submitForReview(h.draft, actor);
    await s.publish(h.draft, actor);
    expect((await s.loadInclude("footer")).body).toEqual([{ paragraph: "foot" }]);
  });

  it("audits the template lifecycle", async () => {
    const s = new MemoryEditableCatalogStore({}, { now });
    const h = await s.createDraft({ ref: tRef("g"), content: templateContent("g", 0, []), actor });
    await s.submitForReview(h.draft, actor);
    await s.publish(h.draft, actor);
    const log = await s.auditLog();
    expect(log.map((e) => e.action)).toEqual(["create_draft", "submit", "publish"]);
    expect(log.at(-1)).toMatchObject({ to: "published", element: { kind: "template", id: "g" }, revision: { version: 1 } });
  });

  it("rejects content whose kind does not match the template ref", async () => {
    const s = new MemoryEditableCatalogStore({}, { now });
    await expect(
      s.createDraft({ ref: tRef("g"), content: includeContent("g", []), actor }),
    ).rejects.toThrow(/does not match template ref/);
  });
});
