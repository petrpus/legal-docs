import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument, type RenderDocumentInput } from "../src/facade/render-document";
import { loan, party } from "../src/core/schema-fragments";
import { signatureGrid } from "../examples/signature-grid";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "..", "legal-docs");

type SampleConfig = Pick<RenderDocumentInput, "data" | "schemas" | "derivations" | "customBlocks">;

const partyData = {
  lender: { name: "Acme Bank a.s.", kind: "company", idNumber: "12345678", address: "1 Bank St" },
  borrower: { name: "Jane Doe", kind: "person" },
  loan: { principal: { amount: 250000, currency: "EUR" } },
};
const termsData = {
  parties: [
    { name: "Alpha", role: "Lender" },
    { name: "Beta", role: "Pledgor" },
    { name: "Gamma", role: "Accession Debtor" },
  ],
  hasGuarantor: true,
};

const samples: Record<string, SampleConfig> = {
  hello: {},
  agreement: {},
  contract: {},
  greeting: {
    data: { name: "Alice", loan: { principal: { amount: 1000, currency: "EUR" } } },
    schemas: { "greeting@1": z.object({ name: z.string(), loan }) },
  },
  parties: {
    data: partyData,
    schemas: { "parties@1": z.object({ lender: party, borrower: party, loan }) },
  },
  signoff: {
    data: { lender: { name: "Acme Bank a.s." }, witness: "John Watson" },
    schemas: { "signoff@1": z.object({ lender: party, witness: z.string() }) },
  },
  terms: {
    data: termsData,
    schemas: {
      "terms@1": z.object({
        parties: z.array(z.object({ name: z.string(), role: z.string() })),
        hasGuarantor: z.boolean(),
      }),
    },
    derivations: {
      counterpartsCount: (p) => (p as typeof termsData).parties.length + 1,
      securityClause: (p) =>
        (p as typeof termsData).parties.length >= 3 ? "counterparts@v2" : "counterparts@v1",
    },
  },
  localized: {},
  "signature-grid": {
    data: {
      signatories: [
        { name: "Acme Bank a.s.", role: "Lender" },
        { name: "Jane Doe", role: "Borrower" },
        { name: "Guarantor Ltd", role: "Guarantor" },
      ],
    },
    customBlocks: { "signature-grid": signatureGrid },
  },
};

describe("sample documents", () => {
  it("has a render config for every template in the sample catalog", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const ids = await catalog.templateIds();

    expect([...ids].sort()).toEqual(Object.keys(samples).sort());
  });

  it("renders every sample template to a PDF with a stable snapshotId", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    for (const [template, config] of Object.entries(samples)) {
      const result = await renderDocument({ catalog, template, format: "pdf", ...config });
      expect(result.buffer.length, `${template} produced an empty PDF`).toBeGreaterThan(500);
      expect(result.snapshotId).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
