import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { Text } from "@react-pdf/renderer";
import { z } from "zod";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { renderFromSnapshot } from "../src/facade/render-from-snapshot";
import { escapeHtml } from "../src/render-html/escape";
import type { CustomBlockRegistry } from "../src/render-pdf/custom-block";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "..", "legal-docs");
const customDir = path.join(here, "fixtures", "custom");

const bannerSchema = z.object({ label: z.string() });
const bannerBlocks: CustomBlockRegistry = {
  banner: {
    schema: bannerSchema,
    pdf: () => createElement(Text, null, "x"),
    html: (props) => `<b>${escapeHtml(bannerSchema.parse(props).label)}</b>`,
  },
};

describe("renderDocument format dispatch", () => {
  it("returns an HTML string for format: html", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const result = await renderDocument({ catalog, template: "hello", data: {}, format: "html" });

    expect(result.format).toBe("html");
    expect(result.html).toContain('<div class="legal-doc">');
    expect(result.html).toContain("DECLARATION");
    expect(result.snapshotId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("still returns a PDF buffer for format: pdf", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const result = await renderDocument({ catalog, template: "hello", data: {}, format: "pdf" });

    expect(result.format).toBe("pdf");
    expect(result.buffer.length).toBeGreaterThan(500);
  });

  it("produces the same snapshotId regardless of format (the Snapshot is format-agnostic)", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const html = await renderDocument({ catalog, template: "hello", data: {}, format: "html" });
    const pdf = await renderDocument({ catalog, template: "hello", data: {}, format: "pdf" });

    expect(html.snapshotId).toBe(pdf.snapshotId);
  });

  it("accepts a runtime (union-typed) format and discriminates the result type", async () => {
    const catalog = await Catalog.fromDir(catalogDir);
    const fmt: "pdf" | "html" = "html";

    const dyn = await renderDocument({ catalog, template: "hello", data: {}, format: fmt });
    expect(dyn.format).toBe("html");
    if (dyn.format === "html") expect(dyn.html).toContain("legal-doc");

    const html = await renderDocument({ catalog, template: "hello", data: {}, format: "html" });
    // @ts-expect-error an HTML result has no `buffer`
    void html.buffer;
    const pdf = await renderDocument({ catalog, template: "hello", data: {}, format: "pdf" });
    // @ts-expect-error a PDF result has no `html`
    void pdf.html;
  });

  it("degrades a custom block missing its html impl when rendering to HTML (facade-level)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = await Catalog.fromDir(customDir);
    const pdfOnly: CustomBlockRegistry = { banner: { pdf: () => createElement(Text, null, "x") } };

    const result = await renderDocument({
      catalog, template: "doc", data: { title: "x" }, customBlocks: pdfOnly, format: "html",
    });

    expect(result.html).toContain("[unsupported block: banner in html]");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("renderFromSnapshot format dispatch", () => {
  it("re-renders a custom-node snapshot to HTML", async () => {
    const catalog = await Catalog.fromDir(customDir);
    const { snapshot } = await renderDocument({
      catalog, template: "doc", data: { title: "HI" }, customBlocks: bannerBlocks, format: "pdf", snapshotMode: "full",
    });

    const result = await renderFromSnapshot(snapshot, { customBlocks: bannerBlocks, format: "html" });

    expect(result.format).toBe("html");
    expect(result.html).toContain("<b>HI</b>");
  });

  it("re-assembles a pins snapshot to HTML (the reassembly path, not a frozen tree)", async () => {
    const catalog = await Catalog.fromDir(customDir);
    const { snapshot } = await renderDocument({
      catalog, template: "doc", data: { title: "HI" }, customBlocks: bannerBlocks, format: "pdf", snapshotMode: "pins",
    });
    expect(snapshot.tree).toBeUndefined();

    const result = await renderFromSnapshot(snapshot, { catalog, customBlocks: bannerBlocks, format: "html" });

    expect(result.html).toContain("<b>HI</b>");
  });
});
