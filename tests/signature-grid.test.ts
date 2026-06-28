import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFParse } from "pdf-parse";
import JSZip from "jszip";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { signatureGrid } from "../examples/signature-grid";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "..", "legal-docs");
const sigGridDir = path.join(here, "fixtures", "sig-grid");

async function text(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const { text } = await parser.getText();
    return text.replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

async function docXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("no word/document.xml");
  return file.async("string");
}

describe("signature-grid special-layout sample", () => {
  it("renders the signature-grid sample to a PDF with every signatory and role (layout: see npm run samples)", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const { buffer } = await renderDocument({
      catalog,
      template: "signature-grid",
      data: {
        signatories: [
          { name: "Acme Bank a.s.", role: "Lender" },
          { name: "Jane Doe", role: "Borrower" },
          { name: "Guarantor Ltd", role: "Guarantor" },
        ],
      },
      customBlocks: { "signature-grid": signatureGrid },
      format: "pdf",
    });

    const out = await text(buffer);
    expect(out).toContain("EXECUTION");
    expect(out).toContain("Acme Bank a.s.");
    expect(out).toContain("Guarantor Ltd");
    expect(out).toContain("Borrower");
  });

  it("renders the signature grid to HTML, escaping its own data, incl. a role-less signatory", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const { html } = await renderDocument({
      catalog,
      template: "signature-grid",
      data: {
        signatories: [
          { name: "Acme & <b>Co</b>", role: "Lender" }, // HTML-special chars
          { name: "Jane Doe" }, // role-less branch
        ],
      },
      customBlocks: { "signature-grid": signatureGrid },
      format: "html",
    });

    expect(html).toContain('class="sig-grid"');
    expect(html).toContain("Acme &amp; &lt;b&gt;Co&lt;/b&gt;"); // escaped, not raw markup
    expect(html).not.toContain("<b>Co</b>");
    expect(html).toContain("Jane Doe");
  });

  it("renders the signature grid to DOCX as a table of signatory names", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const result = await renderDocument({
      catalog,
      template: "signature-grid",
      data: {
        signatories: [
          { name: "Acme Bank a.s.", role: "Lender" },
          { name: "Jane Doe", role: "Borrower" },
        ],
      },
      customBlocks: { "signature-grid": signatureGrid },
      format: "docx",
    });

    const xml = await docXml(result.buffer);
    expect(xml).toContain("<w:tbl>"); // a table
    expect(xml).toContain("Acme Bank a.s.");
    expect(xml).toContain("Borrower");
  });

  it("chunks signatories into rows of `columns` in DOCX (3 at columns=2 → 2 rows), incl. a role-less one", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const result = await renderDocument({
      catalog,
      template: "signature-grid", // its props set columns: 2
      data: {
        signatories: [
          { name: "Alpha", role: "Lender" },
          { name: "Beta" }, // role-less branch
          { name: "Gamma", role: "Guarantor" },
        ],
      },
      customBlocks: { "signature-grid": signatureGrid },
      format: "docx",
    });

    const xml = await docXml(result.buffer);
    expect((xml.match(/<w:tr>/g) ?? []).length).toBeGreaterThanOrEqual(2); // 3 signatories / 2 cols → 2 rows
    for (const name of ["Alpha", "Beta", "Gamma"]) expect(xml).toContain(name);
  });

  it("renders with the default column count and a role-less signatory", async () => {
    const catalog = await Catalog.fromDir(sigGridDir);

    const { buffer } = await renderDocument({
      catalog,
      template: "default-cols",
      data: { signatories: [{ name: "Solo Party" }, { name: "Co Signer", role: "Witness" }] },
      customBlocks: { "signature-grid": signatureGrid },
      format: "pdf",
    });

    const out = await text(buffer);
    expect(out).toContain("Solo Party"); // no-role branch renders without crashing
    expect(out).toContain("Witness");
  });

  it("fails fast if the props violate the block schema", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    await expect(
      renderDocument({
        catalog,
        template: "signature-grid",
        data: { signatories: [{ role: "Lender" }] }, // missing required `name`
        customBlocks: { "signature-grid": signatureGrid },
        format: "pdf",
      }),
    ).rejects.toThrow(/Custom block "signature-grid" received invalid props/);
  });
});
