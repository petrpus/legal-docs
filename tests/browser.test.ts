import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  MemoryCatalogStore,
  resolveTemplate,
  resolveClause,
  renderHtmlInBrowser,
  inspectDocument,
  ExpressionError,
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

/**
 * The Derivations panel demo (issue #127) surfaces each registered Derivation's live output from
 * `inspectDocument().resolved.derived`, and drives `if:`/`for:` blocks off it. These tests are a
 * faithful minimal mirror of the demo's `services-agreement` Template/derivations shape (see
 * docs/demo-src/live-demo.html) and pin the exact contract the panel reads: `counterpartsCount`
 * (from the plain `$parties` array) and `hasGuarantor` (the boolean an `if:` reads), in BOTH states.
 */
describe("browser entry: demo Derivations (Derivations panel contract)", () => {
  const derivations = {
    counterpartsCount: (payload: unknown) => {
      const parties = (payload as { parties?: unknown }).parties;
      return Array.isArray(parties) ? parties.length : 0;
    },
    hasGuarantor: (payload: unknown) => (payload as { guarantor?: unknown }).guarantor != null,
    // Mirrors the demo page's arithmetic derivation, so all three panel entries are pinned by tests.
    feeInclVat: (payload: unknown) => Math.round(Number((payload as { fee?: unknown }).fee) * 1.21),
  };
  const demoSeed: MemoryCatalogSeed = {
    templates: [
      {
        template: "services-agreement",
        version: 1,
        locale: "en",
        derivations: ["counterpartsCount", "hasGuarantor", "feeInclVat"],
        body: [
          {
            for: { each: "$parties", as: "party" },
            body: [{ paragraph: "{{ $party.role }}: {{ $party.name }}" }],
          },
          {
            if: "$derived.hasGuarantor",
            then: [
              { title: "GUARANTOR" },
              { paragraph: "{{ $guarantor.name }} unconditionally guarantees the obligations." },
            ],
          },
          { clause: "counterparts@latest", vars: { count: "$derived.counterpartsCount" } },
        ],
      },
    ],
    clauses: [
      { clause: "counterparts", version: 1, locale: "en", vars: { count: { type: "integer", min: 1 } }, text: "In **{{ $count }}** counterparts." },
      { clause: "counterparts", version: 2, locale: "en", vars: { count: { type: "integer", min: 1 } }, text: "In **{{ $count }}** counterparts, each party receiving one original." },
    ],
  };
  const basePayload = {
    parties: [
      { role: "Client", name: "Acme s.r.o." },
      { role: "Provider", name: "Ludwig Legal Studio" },
    ],
    guarantor: { name: "Berndt Holding a.s." },
    fee: 1000,
  };

  it("guarantor present → hasGuarantor true, the if: section appears, counterpartsCount matches $parties length", async () => {
    const store = new MemoryCatalogStore(demoSeed);
    const result = await inspectDocument({ store, template: "services-agreement", data: basePayload, derivations });
    expect(result.resolved.derived).toEqual({ counterpartsCount: 2, hasGuarantor: true, feeInclVat: 1210 });
    // The if:-driven GUARANTOR section is in the tree and rendered HTML.
    expect(result.tree.body.some((n) => "text" in n && n.text === "GUARANTOR")).toBe(true);
    expect(result.html).toContain("unconditionally guarantees the obligations.");
    expect(result.html).toContain("Berndt Holding a.s.");
    // The for:-expanded party roster made it into the HTML too.
    expect(result.html).toContain("Client: Acme s.r.o.");
    expect(result.html).toContain("Provider: Ludwig Legal Studio");
  });

  it("guarantor removed → hasGuarantor false and the if: section disappears; counterpartsCount tracks $parties", async () => {
    const store = new MemoryCatalogStore(demoSeed);
    const noGuarantor = { parties: basePayload.parties, fee: 1000 };
    const result = await inspectDocument({ store, template: "services-agreement", data: noGuarantor, derivations });
    expect(result.resolved.derived).toEqual({ counterpartsCount: 2, hasGuarantor: false, feeInclVat: 1210 });
    // The whole GUARANTOR section is absent — the Template only reads the derived boolean.
    expect(result.tree.body.some((n) => "text" in n && n.text === "GUARANTOR")).toBe(false);
    expect(result.html).not.toContain("unconditionally guarantees the obligations.");
  });

  it("counterpartsCount follows the $parties array length as the payload changes", async () => {
    const store = new MemoryCatalogStore(demoSeed);
    const threeParties = {
      ...basePayload,
      parties: [...basePayload.parties, { role: "Witness", name: "Dr. Novak" }],
    };
    const result = await inspectDocument({ store, template: "services-agreement", data: threeParties, derivations });
    expect(result.resolved.derived).toMatchObject({ counterpartsCount: 3 });
  });
});

/**
 * The demo's error panel (issue #129) reads the STRUCTURED fields of an `ExpressionError` rather than
 * parsing the message string. This pins the exact contract behind that panel's scenario (2) — a
 * helper/expression that throws *inside* a top-level `for: $parties` loop — so the panel can rely on:
 * `err instanceof ExpressionError` (safe because the demo imports the class from this same bundle),
 * `err.location.path` carrying the ` › for` marker the engine attaches (see `engine.ts` `assembleFor`),
 * a numeric `err.location.iteration` (the loop counter), and a non-empty `err.expression` (the offending
 * source). The crafted payload has a bare-string `$parties` element, so `{{ $party.name }}` throws
 * "Cannot index a string" — no Template change, just the input, exactly like the demo's break-it button.
 */
describe("browser entry: ExpressionError structured fields (error-panel scenario 2)", () => {
  const loopSeed: MemoryCatalogSeed = {
    templates: [
      {
        template: "roster",
        version: 1,
        locale: "en",
        body: [
          {
            for: { each: "$parties", as: "party" },
            body: [{ paragraph: "{{ $party.name }}" }],
          },
        ],
      },
    ],
  };

  it("rejects with an ExpressionError carrying location.path (` › for`), a numeric iteration, and the expression", async () => {
    const store = new MemoryCatalogStore(loopSeed);
    // The second `$parties` element is a bare string, so `$party.name` throws on iteration 1.
    const data = { parties: [{ name: "Acme s.r.o." }, "not-an-object"] };

    const error = await inspectDocument({ store, template: "roster", data }).then(
      () => {
        throw new Error("expected inspectDocument to reject");
      },
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ExpressionError);
    const err = error as ExpressionError;
    expect(err.name).toBe("ExpressionError");
    expect(err.location?.path).toContain(" › for");
    expect(typeof err.location?.iteration).toBe("number");
    expect(err.location?.iteration).toBe(1);
    expect(err.expression).toBeTruthy();
    expect(err.expression).toContain("$party.name");
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

/**
 * The "Variants & Slots" demo section (issue #128) composes a small Template family — one Base
 * declaring shared structure (a `for: $parties` roster) plus two named Slots (`terms`, `guaranty`) —
 * with two Variants that fill the Slots differently, one leaving `guaranty` empty. These tests pin the
 * contract the demo depends on, all through the shared browser pipeline (`inspectDocument({ store,
 * template: <family>, variant })`) rather than any hand-rolled slot filling: the Base region is shared
 * byte-for-byte across Variants, the filled Slot diverges, and the unfilled Slot simply renders nothing
 * (matching `compose.ts` "removed if unfilled"). Also pins that `resolveTemplate` forwards the variant,
 * guarding against a silent regression of `src/browser.ts`'s `variant` plumbing.
 */
describe("browser entry: Variants & Slots", () => {
  const familySeed: MemoryCatalogSeed = {
    families: [
      {
        base: {
          base: "nda",
          version: 1,
          locale: "en",
          body: [
            { title: "NON-DISCLOSURE AGREEMENT" },
            // Shared Base structure: a party roster driven off the payload, identical for every Variant.
            {
              for: { each: "$parties", as: "party" },
              body: [{ paragraph: "{{ $party.role }}: {{ $party.name }}" }],
            },
            { title: "TERMS" },
            { slot: "terms" },
            { slot: "guaranty" },
          ],
        },
        variants: [
          {
            // Fills `terms`, leaves `guaranty` unfilled → the empty-slot state.
            variant: "bilateral",
            extends: "nda",
            parties: ["discloser", "recipient"],
            overrides: {
              terms: [{ paragraph: "Both parties mutually protect the other's Confidential Information." }],
            },
          },
          {
            // Fills `terms` differently AND fills `guaranty` with an extra structural section.
            variant: "with-guarantor",
            extends: "nda",
            parties: ["discloser", "recipient", "guarantor"],
            overrides: {
              terms: [{ paragraph: "The Recipient protects the Discloser's Confidential Information." }],
              guaranty: [
                { title: "GUARANTY" },
                { paragraph: "The Guarantor unconditionally guarantees the Recipient's obligations." },
              ],
            },
          },
        ],
      },
    ],
  };
  // The same payload for both Variants, so the shared `for:` roster is identical between them.
  const payload = {
    parties: [
      { role: "Discloser", name: "Acme s.r.o." },
      { role: "Recipient", name: "Beta a.s." },
    ],
  };
  const render = (variant: string) =>
    inspectDocument({ store: new MemoryCatalogStore(familySeed), template: "nda", variant, data: payload });

  it("both Variants resolve and render through the shared pipeline", async () => {
    const bilateral = await render("bilateral");
    const withGuarantor = await render("with-guarantor");
    for (const result of [bilateral, withGuarantor]) {
      expect(result.tree.body.length).toBeGreaterThan(0);
      expect(result.html).toContain("NON-DISCLOSURE AGREEMENT");
      // The shared Base roster (`for: $parties`) rendered for both.
      expect(result.html).toContain("Discloser: Acme s.r.o.");
      expect(result.html).toContain("Recipient: Beta a.s.");
    }
  });

  it("the Base region is shared byte-for-byte across Variants", async () => {
    const bilateral = await render("bilateral");
    const withGuarantor = await render("with-guarantor");
    // The first four nodes are the Base above the Slots: title, two roster paragraphs, "TERMS" title.
    expect(bilateral.tree.body.slice(0, 4)).toEqual(withGuarantor.tree.body.slice(0, 4));
  });

  it("the filled `terms` Slot diverges between the two Variants", async () => {
    const bilateral = await render("bilateral");
    const withGuarantor = await render("with-guarantor");
    expect(bilateral.html).toContain("Both parties mutually protect");
    expect(withGuarantor.html).toContain("The Recipient protects the Discloser");
    // Concretely different node content at the `terms` Slot position (5th node, index 4).
    expect(bilateral.tree.body[4]).not.toEqual(withGuarantor.tree.body[4]);
  });

  it("the unfilled `guaranty` Slot renders nothing in `bilateral` but is present in `with-guarantor`", async () => {
    const bilateral = await render("bilateral");
    const withGuarantor = await render("with-guarantor");
    // `bilateral` omits the guaranty content entirely — the empty Slot produces no nodes.
    expect(bilateral.html).not.toContain("GUARANTY");
    expect(bilateral.html).not.toContain("unconditionally guarantees");
    expect(bilateral.tree.body.some((n) => "text" in n && n.text === "GUARANTY")).toBe(false);
    // `with-guarantor` fills it, so the extra section appears.
    expect(withGuarantor.html).toContain("GUARANTY");
    expect(withGuarantor.html).toContain("unconditionally guarantees the Recipient");
    expect(withGuarantor.tree.body.some((n) => "text" in n && n.text === "GUARANTY")).toBe(true);
    // The unfilled Variant is strictly shorter — only the guaranty nodes are missing.
    expect(bilateral.tree.body.length).toBeLessThan(withGuarantor.tree.body.length);
  });

  it("resolveTemplate forwards the selected variant onto the composed Template", async () => {
    const store = new MemoryCatalogStore(familySeed);
    expect((await resolveTemplate(store, "nda", "bilateral")).variant).toBe("bilateral");
    expect((await resolveTemplate(store, "nda", "with-guarantor")).variant).toBe("with-guarantor");
  });
});
