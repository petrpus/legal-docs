// Render every sample document to samples/<name>.pdf (and .png if `pdftoppm` is available).
// Run with: npm run samples   (builds first, then executes this against dist/).
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { Catalog, renderDocument, party, loan } from "../dist/index.js";

const root = new URL("..", import.meta.url).pathname;
const outDir = `${root}samples`;
mkdirSync(outDir, { recursive: true });

const catalog = await Catalog.fromDir(`${root}legal-docs`);

const partyData = {
  lender: { name: "Acme Bank a.s.", kind: "company", idNumber: "12345678", address: "1 Bank Street, Prague" },
  borrower: { name: "Jane Doe", kind: "person" },
  loan: { principal: { amount: 250000, currency: "EUR" } },
};
const termsData = {
  parties: [
    { name: "Alpha Capital", role: "Lender" },
    { name: "Beta Holdings", role: "Pledgor" },
    { name: "Gamma Trust", role: "Accession Debtor" },
  ],
  hasGuarantor: true,
};

// One entry per sample template: the data/schemas/derivations it needs.
const samples = {
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
      counterpartsCount: (p) => p.parties.length + 1,
      securityClause: (p) => (p.parties.length >= 3 ? "counterparts@v2" : "counterparts@v1"),
    },
  },
};

const hasPdftoppm = (() => {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Standalone templates: one render each. Variant families are rendered separately below.
const pledgeSchema = { "pledge@1": z.object({ parties: z.array(party) }) };
const variantSamples = [
  {
    template: "pledge-agreement",
    variant: "two-party",
    schemas: pledgeSchema,
    data: { parties: [{ name: "Acme Bank a.s." }, { name: "Jane Doe" }] },
  },
  {
    template: "pledge-agreement",
    variant: "three-party",
    schemas: pledgeSchema,
    data: { parties: [{ name: "Acme Bank a.s." }, { name: "Jane Doe" }, { name: "Guarantor Ltd" }] },
  },
];

async function render(name, config) {
  const { buffer, snapshotId } = await renderDocument({ catalog, format: "pdf", ...config });
  const pdfPath = `${outDir}/${name}.pdf`;
  writeFileSync(pdfPath, buffer);
  if (hasPdftoppm) {
    execFileSync("pdftoppm", ["-png", "-r", "110", "-singlefile", pdfPath, `${outDir}/${name}`]);
  }
  console.log(`✓ ${name}.pdf${hasPdftoppm ? ` + ${name}.png` : ""}  (snapshot ${snapshotId})`);
}

for (const id of await catalog.templateIds()) {
  const config = samples[id];
  if (!config) {
    console.warn(`! no sample config for "${id}" — skipping`);
    continue;
  }
  await render(id, { template: id, ...config });
}

for (const config of variantSamples) {
  await render(`${config.template}-${config.variant}`, config);
}

console.log(`\nWrote samples to ${outDir}${hasPdftoppm ? "" : "  (install poppler-utils for .png too)"}`);
