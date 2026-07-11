import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildSnapshot, assertValidSnapshot, SnapshotError, SNAPSHOT_SCHEMA_VERSION, type Snapshot, type SnapshotInput } from "../src/core/snapshot";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { renderFromSnapshot } from "../src/facade/render-from-snapshot";
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
  tree: { body: [] },
};

describe("buildSnapshot", () => {
  it("freezes inputs and the tree in full mode (default)", () => {
    const snap = buildSnapshot(gen);

    expect(snap.mode).toBe("full");
    expect(snap.payload).toEqual(gen.payload);
    expect(snap.resolved).toEqual(gen.resolved);
    expect(snap.pins).toEqual(gen.pins);
    expect(snap.tree).toEqual({ body: [] });
    expect(snap).toMatchObject({ template: "pledge-agreement", version: 1, variant: "two-party", locale: "en" });
  });

  it("freezes only the tree in tree mode", () => {
    const snap = buildSnapshot(gen, "tree");

    expect(snap.tree).toEqual({ body: [] });
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

  it("stamps the current schema version", () => {
    expect(buildSnapshot(gen).schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(buildSnapshot(gen, "tree").schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(buildSnapshot(gen, "pins").schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
  });

  it("computes a stable, mode-independent id", () => {
    const id = buildSnapshot(gen, "full").id;

    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(buildSnapshot(gen, "tree").id).toBe(id);
    expect(buildSnapshot(gen, "pins").id).toBe(id);
    expect(buildSnapshot(gen, "full").id).toBe(id); // deterministic for identical input
  });

  it("keeps the pre-furniture (v1) id for a furniture-less document", () => {
    // Locks the concrete digest so a future reorder of the hashed keys can't silently churn every
    // persisted id. `gen` has no header/footer, so its id must match what v1 produced.
    expect(buildSnapshot(gen, "full").id).toBe("a356ab1f231ec2ba");
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

describe("snapshot schema-version guard", () => {
  const valid = buildSnapshot({ ...gen, tree: { body: [{ kind: "paragraph", text: "hi" }] } }, "tree");

  it("accepts a well-formed current-version snapshot", () => {
    expect(() => assertValidSnapshot(valid)).not.toThrow();
  });

  it("rejects a non-object, an unknown version, and a malformed snapshot", () => {
    expect(() => assertValidSnapshot(null)).toThrow(SnapshotError);
    expect(() => assertValidSnapshot({ ...valid, schemaVersion: 999 })).toThrow(/schemaVersion 999/);
    const noVersion: Record<string, unknown> = { ...valid };
    delete noVersion.schemaVersion;
    expect(() => assertValidSnapshot(noVersion)).toThrow(SnapshotError);
    expect(() => assertValidSnapshot({ ...valid, template: 123 })).toThrow(/Malformed/);
    expect(() => assertValidSnapshot({ ...valid, mode: "bogus" })).toThrow(/unknown mode/);
    expect(() => assertValidSnapshot({ ...valid, tree: null })).toThrow(/no tree body array/);
    // A v1-shape snapshot (bare array `tree`, no `body`) is malformed under v2.
    expect(() => assertValidSnapshot({ ...valid, tree: [{ kind: "paragraph", text: "hi" }] })).toThrow(/no tree body array/);
  });

  it("blocks renderFromSnapshot on an unknown-version snapshot", async () => {
    const stale = { ...valid, schemaVersion: 999 } as unknown as Snapshot;
    await expect(renderFromSnapshot(stale, { format: "html" })).rejects.toThrow(SnapshotError);
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
    expect(snapshot.tree?.body.length).toBeGreaterThan(0);
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
