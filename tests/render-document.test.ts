import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFParse } from "pdf-parse";
import { z } from "zod";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { assembleTree } from "../src/core/engine";
import { loan } from "../src/core/schema-fragments";

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

    expect(assembleTree(template)).toMatchSnapshot();
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
});
