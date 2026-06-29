import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildSnapshot, type SnapshotInput } from "../src/core/snapshot";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { party } from "../src/core/schema-fragments";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "..", "legal-docs");

const gen: SnapshotInput = {
  template: "pledge-agreement",
  version: 1,
  variant: "two-party",
  locale: "en",
  payload: { parties: [{ name: "Acme" }] },
  resolved: { parties: [{ name: "Acme" }], derived: {} },
  pins: [{ ref: "pledge-security@v1", clause: "pledge-security", version: 1, locale: "en" }],
  tree: [],
};

describe("buildSnapshot", () => {
  it("freezes inputs and the tree in full mode (default)", () => {
    const snap = buildSnapshot(gen);

    expect(snap.mode).toBe("full");
    expect(snap.payload).toEqual(gen.payload);
    expect(snap.resolved).toEqual(gen.resolved);
    expect(snap.pins).toEqual(gen.pins);
    expect(snap.tree).toEqual([]);
    expect(snap).toMatchObject({ template: "pledge-agreement", version: 1, variant: "two-party", locale: "en" });
  });

  it("freezes only the tree in tree mode", () => {
    const snap = buildSnapshot(gen, "tree");

    expect(snap.tree).toEqual([]);
    expect(snap.payload).toBeUndefined();
    expect(snap.resolved).toBeUndefined();
    expect(snap.pins).toBeUndefined();
  });

  it("freezes inputs and pins but no tree in pins mode", () => {
    const snap = buildSnapshot(gen, "pins");

    expect(snap.pins).toEqual(gen.pins);
    expect(snap.payload).toEqual(gen.payload);
    expect(snap.tree).toBeUndefined();
  });

  it("computes a stable, mode-independent id", () => {
    const id = buildSnapshot(gen, "full").id;

    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(buildSnapshot(gen, "tree").id).toBe(id);
    expect(buildSnapshot(gen, "pins").id).toBe(id);
    expect(buildSnapshot(gen, "full").id).toBe(id); // deterministic for identical input
  });

  it("omits variant when the generation has none", () => {
    const standalone: SnapshotInput = { ...gen, variant: undefined };

    expect(buildSnapshot(standalone).variant).toBeUndefined();
  });

  it("deduplicates and deterministically orders clause pins", () => {
    const a = { ref: "a@v1", clause: "a", version: 1, locale: "en" };
    const b = { ref: "b@v2", clause: "b", version: 2, locale: "en" };
    // b appears twice (e.g. resolved once per loop iteration) and out of order.
    const snap = buildSnapshot({ ...gen, pins: [b, a, b] }, "pins");

    expect(snap.pins).toEqual([a, b]);
  });
});

describe("renderDocument snapshots", () => {
  const schemas = { "pledge@1": z.object({ parties: z.array(party) }) };
  const data = { parties: [{ name: "Acme Bank" }, { name: "Jane Doe" }] };

  async function render(snapshotMode?: "full" | "tree" | "pins") {
    const catalog = await Catalog.fromDir(catalogDir);
    return renderDocument({
      catalog, template: "pledge-agreement", variant: "two-party", data, schemas, format: "pdf", snapshotMode,
    });
  }

  it("returns a full snapshot by default, with the resolved clause pinned", async () => {
    const { snapshot, snapshotId } = await render();

    expect(snapshot.mode).toBe("full");
    expect(snapshot.id).toBe(snapshotId);
    expect(snapshot).toMatchObject({ template: "pledge-agreement", variant: "two-party" });
    expect(snapshot.pins).toContainEqual({
      ref: "pledge-security@v1",
      clause: "pledge-security",
      version: 1,
      locale: "en",
      resolvedLocale: "en",
    });
    expect(snapshot.tree?.length).toBeGreaterThan(0);
  });

  it("honours the requested snapshot mode", async () => {
    expect((await render("tree")).snapshot.tree).toBeDefined();
    expect((await render("tree")).snapshot.pins).toBeUndefined();
    expect((await render("pins")).snapshot.tree).toBeUndefined();
    expect((await render("pins")).snapshot.pins?.[0]?.clause).toBe("pledge-security");
  });

  it("produces a plain JSON-serializable snapshot", async () => {
    const { snapshot } = await render();

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});
