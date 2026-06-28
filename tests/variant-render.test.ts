import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFParse } from "pdf-parse";
import { z } from "zod";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { party } from "../src/core/schema-fragments";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "..", "legal-docs");

const schemas = { "pledge@1": z.object({ parties: z.array(party) }) };
const twoPartyData = { parties: [{ name: "Acme Bank" }, { name: "Jane Doe" }] };
const threePartyData = {
  parties: [{ name: "Acme Bank" }, { name: "Jane Doe" }, { name: "Guarantor Ltd" }],
};

async function extractText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const { text } = await parser.getText();
    return text.replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

describe("pledge-agreement variants (end-to-end PDF)", () => {
  it("renders the two-party variant with its v1 security clause", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const result = await renderDocument({
      catalog,
      template: "pledge-agreement",
      variant: "two-party",
      data: twoPartyData,
      schemas,
      format: "pdf",
    });

    expect(result.buffer.length).toBeGreaterThan(500);
    const text = await extractText(result.buffer);
    expect(text).toContain("PLEDGE AGREEMENT");
    expect(text).toContain("the obligations of the two parties");
    expect(text).not.toContain("accession debtor");
  });

  it("renders the three-party variant with its v2 security clause and an extra party", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const result = await renderDocument({
      catalog,
      template: "pledge-agreement",
      variant: "three-party",
      data: threePartyData,
      schemas,
      format: "pdf",
    });

    const text = await extractText(result.buffer);
    expect(text).toContain("including the accession debtor");
    expect(text).toContain("Guarantor Ltd");
    expect(text).toContain("Party 3");
  });

  it("selects the Slot-overridden clause by variant, independent of the party data", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    // Render both variants with identical data: the only output delta must be the security clause the
    // Variant's Slot override selects — isolating variant selection from the data-driven party loop.
    const data = twoPartyData;
    const two = await renderDocument({
      catalog, template: "pledge-agreement", variant: "two-party", data, schemas, format: "pdf",
    });
    const three = await renderDocument({
      catalog, template: "pledge-agreement", variant: "three-party", data, schemas, format: "pdf",
    });

    expect(await extractText(two.buffer)).toContain("the obligations of the two parties");
    expect(await extractText(three.buffer)).toContain("including the accession debtor");
  });

  it("gives the two variants different snapshot ids", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const two = await renderDocument({
      catalog, template: "pledge-agreement", variant: "two-party", data: twoPartyData, schemas, format: "pdf",
    });
    const three = await renderDocument({
      catalog, template: "pledge-agreement", variant: "three-party", data: threePartyData, schemas, format: "pdf",
    });

    expect(two.snapshotId).not.toBe(three.snapshotId);
  });

  it("fails fast when an unknown variant is requested", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    await expect(
      renderDocument({
        catalog, template: "pledge-agreement", variant: "ghost", data: twoPartyData, schemas, format: "pdf",
      }),
    ).rejects.toThrow(/not found in family "pledge-agreement"/);
  });
});
