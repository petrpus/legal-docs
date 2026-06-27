import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFParse } from "pdf-parse";
import { z } from "zod";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { assembleTree } from "../src/core/engine";
import { loan, party } from "../src/core/schema-fragments";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "..", "legal-docs");

async function extractText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const { text } = await parser.getText();
    // Collapse layout whitespace (line wrapping) so assertions check content, not pagination.
    return text.replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

describe("renderDocument (walking skeleton)", () => {
  it("loads a YAML template and renders a PDF containing its text", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const result = await renderDocument({ catalog, template: "hello", data: {}, format: "pdf" });

    expect(result.buffer).toBeInstanceOf(Buffer);
    const text = await extractText(result.buffer);
    expect(text).toContain("DECLARATION AND CONFIRMATION");
    expect(text).toContain("renderer-agnostic document tree");
    // Pin the (pagination-normalized) PDF text-layer as a golden snapshot.
    expect(text).toMatchSnapshot("pdf-text-layer");
    expect(result.snapshotId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("assembles the expected tree (golden)", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const template = await catalog.getTemplate("hello");

    expect(await assembleTree(template)).toMatchSnapshot();
  });

  it("produces a stable snapshotId for identical inputs", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const a = await renderDocument({ catalog, template: "hello", data: {}, format: "pdf" });
    const b = await renderDocument({ catalog, template: "hello", data: {}, format: "pdf" });

    expect(a.snapshotId).toBe(b.snapshotId);
  });

  it("validates the payload and binds values into the rendered PDF", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const schemas = { "greeting@1": z.object({ name: z.string().min(1), loan }) };
    const result = await renderDocument({
      catalog,
      template: "greeting",
      data: { name: "Alice", loan: { principal: { amount: 1000, currency: "EUR" } } },
      schemas,
      format: "pdf",
    });

    const text = await extractText(result.buffer);
    expect(text).toContain("Dear Alice, your loan principal is EUR 1000.00.");
  });

  it("rejects an invalid payload with a path-precise error", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const schemas = { "greeting@1": z.object({ name: z.string().min(1), loan }) };

    await expect(
      renderDocument({ catalog, template: "greeting", data: { loan: undefined }, schemas, format: "pdf" }),
    ).rejects.toThrow(/name/);
  });

  it("resolves @latest to the newest clause version and @vN to a pinned one", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const latest = await catalog.getClause("counterparts@latest", "en");
    expect(latest.version).toBe(2);
    expect(latest.text).toContain("counterpart copies");

    const pinned = await catalog.getClause("counterparts@v1", "en");
    expect(pinned.version).toBe(1);
    expect(pinned.text).toContain("executed in");
  });

  it("renders a clause into the PDF using its @latest wording", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const result = await renderDocument({ catalog, template: "agreement", format: "pdf" });

    const text = await extractText(result.buffer);
    expect(text).toContain("AGREEMENT");
    expect(text).toContain("signed in 2 counterpart copies of equal legal force");
  });

  it("assembles the article/list document tree (golden)", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const template = await catalog.getTemplate("contract");

    expect(
      await assembleTree(template, {
        clauses: (ref, locale) => catalog.getClause(ref, locale),
        locale: template.locale,
      }),
    ).toMatchSnapshot();
  });

  it("renders articles (incl. nested) and lists into the PDF", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const result = await renderDocument({ catalog, template: "contract", format: "pdf" });

    const text = await extractText(result.buffer);
    expect(text).toContain("SERVICE CONTRACT");
    expect(text).toContain("1. Definitions");
    expect(text).toContain("Provider means the party rendering services.");
    expect(text).toContain("signed in 2 counterpart copies");
    expect(text).toContain("2.1.");
    expect(text).toContain("This sub-article is nested.");
    expect(text).toContain("Bullet one.");
    // Alpha list markers render before each item.
    expect(text).toMatch(/a\.\s*Alpha point a\./);
    expect(text).toMatch(/b\.\s*Alpha point b\./);
  });

  const partyData = {
    lender: { name: "Acme Bank", kind: "company", idNumber: "12345678", address: "1 Bank St" },
    borrower: { name: "Jane Doe", kind: "person" },
    loan: { principal: { amount: 1000, currency: "EUR" } },
  };
  const partySchemas = {
    "parties@1": z.object({ lender: party, borrower: party, loan }),
  };

  it("assembles the party-header / key-value document tree (golden)", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const template = await catalog.getTemplate("parties");

    expect(await assembleTree(template, { scope: partyData })).toMatchSnapshot();
  });

  it("renders partyHeader and keyValueTable into the PDF", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const result = await renderDocument({
      catalog,
      template: "parties",
      data: partyData,
      schemas: partySchemas,
      format: "pdf",
    });

    const text = await extractText(result.buffer);
    expect(text).toContain("Lender");
    expect(text).toContain("Acme Bank");
    expect(text).toContain("12345678");
    expect(text).toContain("Borrower");
    expect(text).toContain("Jane Doe");
    expect(text).toContain("Principal");
    expect(text).toContain("EUR 1000.00");
  });
});
