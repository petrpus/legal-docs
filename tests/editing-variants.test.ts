import { describe, it, expect } from "vitest";
import { Catalog } from "../src/catalog/catalog";
import { MemoryEditableCatalogStore } from "../src/catalog/memory-editable-catalog-store";
import { PublishValidationError } from "../src/catalog/editing-facade";
import type { Actor, ElementContent, ElementRef } from "../src/catalog/editable-catalog-store";
import type { BaseTemplate, Variant } from "../src/core/template";

const actor: Actor = { id: "u1", name: "Editor" };
const now = () => "2026-01-01T00:00:00Z";

// A family whose base declares a `security` slot for a variant to fill.
const pledgeBase = (version = 1): BaseTemplate => ({ base: "pledge", version, locale: "en", body: [{ title: "PLEDGE" }, { slot: "security" }] });
const variantContent = (v: Variant): ElementContent => ({ kind: "variant", variant: v });
const vRef = (variant: string): ElementRef => ({ kind: "variant", family: "pledge", variant });

const goodVariant: Variant = { variant: "two-party", extends: "pledge", parties: ["lender", "pledgor"], overrides: { security: [{ paragraph: "Security over the collateral." }] } };
const badVariant: Variant = { variant: "bad", extends: "pledge", overrides: { nonexistent: [{ paragraph: "x" }] } };

const family = () => new MemoryEditableCatalogStore({ families: [{ base: pledgeBase() }] }, { now });

describe("MemoryEditableCatalogStore — variants & bases (ADR-0009)", () => {
  it("keeps a variant draft invisible until published, then composes the family with it", async () => {
    const store = family();
    const cat = Catalog.fromStore(store);
    const h = await cat.editing.createDraft({ ref: vRef("two-party"), content: variantContent(goodVariant), actor });
    expect(h.draft.version).toBe(0); // variants are versionless
    expect(await store.variantIds("pledge")).toEqual([]); // hidden
    await cat.editing.submitForReview(h.draft, actor);
    await cat.editing.publish(h.draft, actor);
    expect(await store.variantIds("pledge")).toEqual(["two-party"]);
    const composed = await cat.getTemplate("pledge", "two-party");
    expect(composed.body).toContainEqual({ paragraph: "Security over the collateral." });
  });

  it("blocks publishing a variant whose override names an undeclared slot (composition gate)", async () => {
    const store = family();
    const cat = Catalog.fromStore(store);
    const h = await cat.editing.createDraft({ ref: vRef("bad"), content: variantContent(badVariant), actor });
    await cat.editing.submitForReview(h.draft, actor);
    await expect(cat.editing.publish(h.draft, actor)).rejects.toBeInstanceOf(PublishValidationError);
    expect(await store.variantIds("pledge")).toEqual([]); // nothing published
  });

  it("bumps the base version on publish, keeping the family composable", async () => {
    const store = new MemoryEditableCatalogStore({ families: [{ base: pledgeBase(1), variants: [goodVariant] }] }, { now });
    const cat = Catalog.fromStore(store);
    const bRef: ElementRef = { kind: "base", family: "pledge" };
    const h = await cat.editing.createDraft({
      ref: bRef,
      content: { kind: "base", base: { base: "pledge", version: 1, locale: "en", body: [{ title: "PLEDGE AGREEMENT" }, { slot: "security" }] } },
      actor,
    });
    expect(h.draft.version).toBe(2);
    await cat.editing.submitForReview(h.draft, actor);
    await cat.editing.publish(h.draft, actor);
    expect((await store.loadBase("pledge")).version).toBe(2);
    expect((await cat.getTemplate("pledge", "two-party")).body).toContainEqual({ title: "PLEDGE AGREEMENT" });
  });

  it("rejects publishing a variant into a family with no published base", async () => {
    const store = new MemoryEditableCatalogStore({}, { now }); // no family/base seeded
    const cat = Catalog.fromStore(store);
    const h = await cat.editing.createDraft({ ref: vRef("two-party"), content: variantContent({ ...goodVariant }), actor });
    await cat.editing.submitForReview(h.draft, actor);
    await expect(cat.editing.publish(h.draft, actor)).rejects.toThrow(/has no published base/);
    expect(await store.variantIds("pledge")).toEqual([]);
  });

  it("audits the variant lifecycle (versionless — no revision.version)", async () => {
    const store = family();
    const cat = Catalog.fromStore(store);
    const h = await cat.editing.createDraft({ ref: vRef("two-party"), content: variantContent(goodVariant), actor });
    await cat.editing.submitForReview(h.draft, actor);
    await cat.editing.publish(h.draft, actor);
    const log = await store.auditLog();
    expect(log.map((e) => e.action)).toEqual(["create_draft", "submit", "publish"]);
    expect(log.at(-1)).toMatchObject({ to: "published", element: { kind: "variant", family: "pledge", variant: "two-party" } });
    expect(log.at(-1)?.revision).toBeUndefined(); // versionless
  });
});
