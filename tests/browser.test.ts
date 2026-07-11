import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  MemoryCatalogStore,
  resolveTemplate,
  resolveClause,
  renderHtmlInBrowser,
  inspectDocument,
} from "../src/browser";
import type { MemoryCatalogSeed } from "../src/browser";

/**
 * `src/browser.ts` is a separate, hand-maintained entry (bundled standalone for the in-browser demo —
 * see tsup.config.ts) that resolves templates/clauses via `src/catalog/resolve.ts` (shared with
 * `Catalog.getTemplate`/`getClause`) against a bare `CatalogStore`, instead of importing the `Catalog`
 * class — specifically to avoid pulling `FileCatalogStore` (`node:fs`) into the browser bundle. These
 * tests pin its pipeline (variant composition, `@latest` resolution, Include expansion, schema/
 * derivation binding, HTML rendering) end to end through the browser entry.
 */
const seed: MemoryCatalogSeed = {
  templates: [
    {
      template: "welcome",
      version: 1,
      locale: "en",
      body: [{ title: "Hello" }, { include: "footer-note" }],
    },
    {
      template: "invoice",
      version: 1,
      locale: "en",
      payloadSchema: "invoice@1",
      derivations: ["total"],
      body: [{ paragraph: "Total due: {{ $derived.total }}" }],
    },
    {
      template: "contract",
      version: 1,
      locale: "en",
      body: [{ clause: "counterparts@latest", vars: { count: 3 } }],
    },
  ],
  includes: [{ id: "footer-note", body: [{ paragraph: "Thanks for reading." }] }],
  families: [
    {
      base: {
        base: "agreement",
        version: 1,
        locale: "en",
        body: [
          { partyHeader: { party: "$client", roleLabel: "Client" } },
          { slot: "body" },
          { signatures: { places: [{ party: "$client" }] } },
        ],
      },
      variants: [
        { variant: "simple", extends: "agreement", overrides: { body: [{ clause: "welcome-note" }] } },
      ],
    },
  ],
  clauses: [
    { clause: "welcome-note", version: 1, locale: "en", vars: {}, text: "Welcome aboard." },
    { clause: "counterparts", version: 1, locale: "en", vars: { count: { type: "integer", min: 1 } }, text: "v1 text" },
    { clause: "counterparts", version: 2, locale: "en", vars: { count: { type: "integer", min: 1 } }, text: "In **{{ $count }}** counterparts." },
  ],
};

describe("browser entry: template/variant/clause resolution", () => {
  it("loads a standalone template", async () => {
    const store = new MemoryCatalogStore(seed);
    const template = await resolveTemplate(store, "welcome");
    expect(template.template).toBe("welcome");
  });

  it("composes a family Variant", async () => {
    const store = new MemoryCatalogStore(seed);
    const template = await resolveTemplate(store, "agreement", "simple");
    expect(template.variant).toBe("simple");
    expect(template.body).toContainEqual({ clause: "welcome-note" });
  });

  it("resolves a pinned clause version", async () => {
    const store = new MemoryCatalogStore(seed);
    const clause = await resolveClause(store, "counterparts@v1", "en");
    expect(clause.text).toBe("v1 text");
  });

  it("resolves @latest to the highest published version", async () => {
    const store = new MemoryCatalogStore(seed);
    const clause = await resolveClause(store, "counterparts@latest", "en");
    expect(clause.version).toBe(2);
  });
});

/**
 * The propagation semantics the "Clause versioning" demo section relies on (issue #126), proved through
 * the same shared `resolveClause` path the browser inspector uses. The demo re-seeds a fresh
 * `MemoryCatalogStore` per published-version state, so these mirror that: a v1-only store vs a v1+v2
 * store. `@latest` follows the newest published version across a publish; a pinned `@v1` reference stays
 * frozen on v1's wording after v2 exists.
 */
describe("browser entry: clause-version propagation (pinned vs @latest)", () => {
  const counterpartsV1: NonNullable<MemoryCatalogSeed["clauses"]> = [
    { clause: "counterparts", version: 1, locale: "en", vars: { count: { type: "integer", min: 1 } }, text: "v1 text" },
  ];
  const counterpartsV1AndV2: NonNullable<MemoryCatalogSeed["clauses"]> = [
    ...counterpartsV1,
    { clause: "counterparts", version: 2, locale: "en", vars: { count: { type: "integer", min: 1 } }, text: "In **{{ $count }}** counterparts." },
  ];
  const v1OnlyStore = () => new MemoryCatalogStore({ clauses: counterpartsV1 });
  const v1AndV2Store = () => new MemoryCatalogStore({ clauses: counterpartsV1AndV2 });

  it("@latest tracks the newest published version — v1 when only v1 exists, v2 once v2 is published", async () => {
    const before = await resolveClause(v1OnlyStore(), "counterparts@latest", "en");
    expect(before.version).toBe(1);
    expect(before.text).toBe("v1 text");

    const after = await resolveClause(v1AndV2Store(), "counterparts@latest", "en");
    expect(after.version).toBe(2);
    expect(after.text).not.toBe("v1 text");
  });

  it("a pinned @v1 reference stays frozen on v1 wording after a newer v2 is published", async () => {
    const before = await resolveClause(v1OnlyStore(), "counterparts@v1", "en");
    const after = await resolveClause(v1AndV2Store(), "counterparts@v1", "en");

    expect(before.version).toBe(1);
    expect(after.version).toBe(1);
    expect(after.text).toBe(before.text);
    expect(after.text).toBe("v1 text");
  });
});

describe("browser entry: renderHtmlInBrowser", () => {
  it("expands Includes and renders the resulting HTML", async () => {
    const store = new MemoryCatalogStore(seed);
    const html = await renderHtmlInBrowser({ store, template: "welcome" });
    expect(html).toContain('class="legal-doc"');
    expect(html).toContain("Hello");
    expect(html).toContain("Thanks for reading.");
  });

  it("resolves clause: items through the store", async () => {
    const store = new MemoryCatalogStore(seed);
    const html = await renderHtmlInBrowser({ store, template: "agreement", variant: "simple", data: { client: { name: "Acme s.r.o." } } });
    expect(html).toContain("Welcome aboard.");
    expect(html).toContain("Acme s.r.o.");
    expect(html).toContain('class="signatures"');
  });

  it("validates the payload against a registered schema and runs Derivations", async () => {
    const store = new MemoryCatalogStore(seed);
    const invoiceSchema = z.object({ amount: z.number() });
    const html = await renderHtmlInBrowser({
      store,
      template: "invoice",
      data: { amount: 42 },
      schemas: { "invoice@1": invoiceSchema },
      derivations: { total: (payload) => `$${(payload as { amount: number }).amount}` },
    });
    expect(html).toContain("Total due: $42");
  });

  it("throws when the template's payloadSchema has no registered schema", async () => {
    const store = new MemoryCatalogStore(seed);
    await expect(renderHtmlInBrowser({ store, template: "invoice", data: { amount: 1 } })).rejects.toThrow(
      /No payload schema registered for "invoice@1"/,
    );
  });

  it("applies a partial theme override", async () => {
    const store = new MemoryCatalogStore(seed);
    const html = await renderHtmlInBrowser({ store, template: "welcome", theme: { fontSize: { title: 30 } } });
    expect(html).toContain("font-size:30px");
  });
});

describe("browser entry: inspectDocument", () => {
  it("exposes the Resolved payload carrying the $derived.* namespace", async () => {
    const store = new MemoryCatalogStore(seed);
    const invoiceSchema = z.object({ amount: z.number() });
    const result = await inspectDocument({
      store,
      template: "invoice",
      data: { amount: 42 },
      schemas: { "invoice@1": invoiceSchema },
      derivations: { total: (payload) => `$${(payload as { amount: number }).amount}` },
    });
    expect(result.payload).toEqual({ amount: 42 });
    expect(result.resolved).toMatchObject({ amount: 42, derived: { total: "$42" } });
  });

  it("records each Clause reference with the concrete resolved version and locale", async () => {
    const store = new MemoryCatalogStore(seed);
    const result = await inspectDocument({ store, template: "contract" });
    expect(result.references).toEqual([
      { ref: "counterparts@latest", clause: "counterparts", version: 2, locale: "en", resolvedLocale: "en" },
    ]);
    // The resolved v2 wording (not v1's "v1 text") made it into the HTML.
    expect(result.html).toContain("In <strong>3</strong> counterparts.");
    expect(result.html).not.toContain("v1 text");
  });

  it("surfaces pipeline errors (missing payload schema) instead of swallowing them", async () => {
    const store = new MemoryCatalogStore(seed);
    await expect(
      inspectDocument({ store, template: "invoice", data: { amount: 42 } }),
    ).rejects.toThrow(/No payload schema registered for "invoice@1"/);
  });

  it("returns html byte-equal to renderHtmlInBrowser for the same input", async () => {
    const store = new MemoryCatalogStore(seed);
    const input = { store, template: "agreement", variant: "simple", data: { client: { name: "Acme s.r.o." } } };
    const inspected = await inspectDocument(input);
    const rendered = await renderHtmlInBrowser(input);
    expect(inspected.html).toBe(rendered);
  });
});
