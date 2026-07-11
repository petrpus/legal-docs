import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { PDFParse } from "pdf-parse";
import { party } from "../src/core/schema-fragments";
import { assembleDocument } from "../src/core/engine";
import { renderTreeToPdf } from "../src/render-pdf/render-pdf";
import { renderTreeToHtml } from "../src/render-html/render-html";
import { PAGE_NUMBER_SENTINEL, PAGE_TOTAL_SENTINEL } from "../src/core/document-tree";
import { Catalog } from "../src/catalog/catalog";
import { MemoryCatalogStore } from "../src/catalog/memory-catalog-store";
import { renderDocument } from "../src/facade/render-document";
import { renderFromSnapshot } from "../src/facade/render-from-snapshot";
import type { Template } from "../src/core/template";

const headed: Template = {
  template: "nda",
  version: 1,
  locale: "en",
  body: [{ paragraph: "Body text." }],
  header: { left: "{{ $party }}", right: "{{ $page.number }} / {{ $page.total }}" },
  footer: { center: "Confidential" },
};

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const { text } = await parser.getText();
    return text.replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

describe("page furniture — assembly", () => {
  it("interpolates scope tokens and leaves page tokens as sentinels", async () => {
    const tree = await assembleDocument(headed, { scope: { party: "ACME" } });
    expect(tree.header).toEqual({ left: "ACME", right: `${PAGE_NUMBER_SENTINEL} / ${PAGE_TOTAL_SENTINEL}` });
    expect(tree.footer).toEqual({ center: "Confidential" });
    // The body is unchanged by furniture.
    expect(tree.body).toEqual([{ kind: "paragraph", text: "Body text." }]);
  });

  it("omits furniture entirely when the template declares none", async () => {
    const tree = await assembleDocument({ template: "t", version: 1, locale: "en", body: [{ paragraph: "x" }] });
    expect(tree.header).toBeUndefined();
    expect(tree.footer).toBeUndefined();
  });
});

describe("page furniture — PDF", () => {
  it("renders header/footer text and substitutes the page number per page", async () => {
    const tree = await assembleDocument(headed, { scope: { party: "ACME" } });
    const text = await pdfText(await renderTreeToPdf(tree));
    expect(text).toContain("ACME");
    expect(text).toContain("Confidential");
    // The single-page document resolves $page.number/$page.total to 1 / 1 — no raw sentinel leaks.
    expect(text).toContain("1 / 1");
    expect(text).not.toContain(PAGE_NUMBER_SENTINEL);
  });

  it("substitutes a distinct page number on each page of a multi-page document", async () => {
    // Enough body to overflow onto a second page, so the footer must render "1 / N" then "2 / N".
    const long: Template = {
      ...headed,
      body: Array.from({ length: 120 }, (_, i) => ({ paragraph: `Paragraph number ${i + 1}.` })),
      footer: { center: "{{ $page.number }} of {{ $page.total }}" },
    };
    const tree = await assembleDocument(long, { scope: { party: "ACME" } });
    const text = await pdfText(await renderTreeToPdf(tree));
    // The `render` callback re-fires per page, so both page ordinals appear and no sentinel leaks.
    expect(text).toMatch(/1 of \d/);
    expect(text).toMatch(/2 of \d/);
    expect(text).not.toContain(PAGE_TOTAL_SENTINEL);
  });
});

describe("page furniture — HTML ignores it (paged-only, ADR-0011)", () => {
  it("renders the body only, dropping header/footer", async () => {
    const tree = await assembleDocument(headed, { scope: { party: "ACME" } });
    const html = renderTreeToHtml(tree);
    expect(html).toContain("Body text.");
    expect(html).not.toContain("ACME");
    expect(html).not.toContain("Confidential");
  });
});

describe("page furniture — loaded from a YAML file catalog", () => {
  // Regression: FileCatalogStore.toTemplate must carry header/footer through — the file path is the
  // primary authoring surface, and an inline-object test would not exercise it.
  const catalogDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "legal-docs");
  const schemas = { "nda@1": z.object({ party, amount: z.number(), currency: z.string(), date: z.string() }) };
  const data = { party: { name: "Acme Bank a.s." }, amount: 50000, currency: "EUR", date: "2026-07-06" };

  it("carries a template's header/footer from YAML and renders them to PDF", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const loaded = await catalog.getTemplate("nda-headed");
    expect(loaded.header).toMatchObject({ left: "{{ $party.name }}" });
    expect(loaded.footer).toMatchObject({ center: expect.stringContaining("Confidential") });

    const { snapshot, buffer } = await renderDocument({ catalog, template: "nda-headed", format: "pdf", schemas, data });
    expect(snapshot.tree?.header).toBeDefined();
    const text = await pdfText(buffer);
    expect(text).toContain("Acme Bank a.s.");
    expect(text).toContain("Confidential");
  });

  it("rejects malformed furniture with a typed authoring error", async () => {
    const badDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "bad-furniture");
    const catalog = await Catalog.fromDir(badDir);
    // header is a bare string, not a { left/center/right } object.
    await expect(catalog.getTemplate("badhdr")).rejects.toThrow(/header must be an object/);
    // footer.center is a number, not a string.
    await expect(catalog.getTemplate("badslot")).rejects.toThrow(/footer "center" must be a string/);
  });
});

describe("page furniture — Snapshot freezes it for deterministic re-render", () => {
  const catalog = () => Catalog.fromStore(new MemoryCatalogStore({ templates: [headed] }));

  it("freezes header/footer in the snapshot tree and re-renders them identically", async () => {
    const { snapshot } = await renderDocument({ catalog: catalog(), template: "nda", data: { party: "ACME" }, format: "pdf" });
    // Furniture is frozen in the tree, not recomputed at re-render.
    expect(snapshot.tree?.header).toEqual({ left: "ACME", right: `${PAGE_NUMBER_SENTINEL} / ${PAGE_TOTAL_SENTINEL}` });

    const text = await pdfText((await renderFromSnapshot(snapshot, { format: "pdf" })).buffer);
    expect(text).toContain("ACME");
    expect(text).toContain("Confidential");
    expect(text).toContain("1 / 1");
  });
});
