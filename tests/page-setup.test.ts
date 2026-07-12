import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { renderTreeToPdf } from "../src/render-pdf/render-pdf";
import { renderTreeToDocx } from "../src/render-docx/render-docx";
import { assembleDocument } from "../src/core/engine";
import { buildSnapshot } from "../src/core/snapshot";
import { Catalog } from "../src/catalog/catalog";
import { MemoryCatalogStore } from "../src/catalog/memory-catalog-store";
import { renderDocument } from "../src/facade/render-document";
import { renderFromSnapshot } from "../src/facade/render-from-snapshot";
import type { Template } from "../src/core/template";
import { PAGE_SIZES, effectivePage } from "../src/core/page";
import { defaultTheme, mergeTheme } from "../src/theme";
import type { DocumentBody } from "../src/core/document-tree";

const body: DocumentBody = [{ kind: "paragraph", text: "Page geometry probe." }];

/** The first page's MediaBox [width, height] from a rendered PDF (react-pdf stores float32 values). */
function mediaBox(buffer: Buffer): [number, number] {
  const match = buffer.toString("latin1").match(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
  if (!match) throw new Error("No MediaBox found in PDF buffer");
  return [Number(match[1]), Number(match[2])];
}

describe("effectivePage — precedence", () => {
  it("defaults to the theme's A4 portrait", () => {
    expect(effectivePage(defaultTheme)).toEqual({ size: "A4", orientation: "portrait" });
  });

  it("reads a themed size and orientation", () => {
    const theme = mergeTheme({ page: { size: "LEGAL", orientation: "landscape" } });
    expect(effectivePage(theme)).toEqual({ size: "LEGAL", orientation: "landscape" });
  });

  it("lets an override win per-field, falling back to the theme for the rest", () => {
    const theme = mergeTheme({ page: { size: "LETTER", orientation: "landscape" } });
    expect(effectivePage(theme, { size: "A5" })).toEqual({ size: "A5", orientation: "landscape" });
    expect(effectivePage(theme, { orientation: "portrait" })).toEqual({ size: "LETTER", orientation: "portrait" });
    expect(effectivePage(theme, {})).toEqual({ size: "LETTER", orientation: "landscape" });
  });
});

describe("PAGE_SIZES — dimension table", () => {
  it("covers the standard set with portrait dimensions in points", () => {
    expect(Object.keys(PAGE_SIZES).sort()).toEqual(["A3", "A4", "A5", "LEGAL", "LETTER", "TABLOID"]);
    for (const { width, height } of Object.values(PAGE_SIZES)) {
      expect(width).toBeLessThan(height); // portrait reference — orientation swaps at render time
    }
  });
});

describe("page geometry — PDF", () => {
  it("renders A4 portrait by default", async () => {
    const [w, h] = mediaBox(await renderTreeToPdf(body));
    expect(w).toBeCloseTo(PAGE_SIZES.A4.width, 1);
    expect(h).toBeCloseTo(PAGE_SIZES.A4.height, 1);
  });

  it("renders a themed LEGAL landscape page (swapped MediaBox)", async () => {
    const buffer = await renderTreeToPdf(body, { theme: { page: { size: "LEGAL", orientation: "landscape" } } });
    const [w, h] = mediaBox(buffer);
    expect(w).toBeCloseTo(PAGE_SIZES.LEGAL.height, 1);
    expect(h).toBeCloseTo(PAGE_SIZES.LEGAL.width, 1);
  });

  it("renders every named format at its portrait dimensions", async () => {
    for (const size of Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]) {
      const dims = PAGE_SIZES[size];
      const buffer = await renderTreeToPdf(body, { theme: { page: { size } } });
      const [w, h] = mediaBox(buffer);
      expect(w, `${size} width`).toBeCloseTo(dims.width, 1);
      expect(h, `${size} height`).toBeCloseTo(dims.height, 1);
    }
  });
});

describe("page geometry — DOCX", () => {
  async function sectionXml(buffer: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(buffer);
    return zip.file("word/document.xml")!.async("string");
  }

  it("emits explicit A4 portrait page size and padding-derived margins by default", async () => {
    const xml = await sectionXml(await renderTreeToDocx(body));
    // twips: A4 595.28×841.89 pt ×20, rounded; margins from theme.page.padding (48 pt → 960).
    expect(xml).toMatch(/<w:pgSz [^/>]*w:w="11906"/);
    expect(xml).toMatch(/<w:pgSz [^/>]*w:h="16838"/);
    expect(xml).toMatch(/<w:pgSz [^/>]*w:orient="portrait"/);
    expect(xml).toMatch(/<w:pgMar [^/>]*w:top="960"/);
    expect(xml).toMatch(/<w:pgMar [^/>]*w:right="960"/);
    expect(xml).toMatch(/<w:pgMar [^/>]*w:bottom="960"/);
    expect(xml).toMatch(/<w:pgMar [^/>]*w:left="960"/);
  });

  it("emits swapped dimensions and w:orient for a themed LEGAL landscape page", async () => {
    const buffer = await renderTreeToDocx(body, { theme: { page: { size: "LEGAL", orientation: "landscape" } } });
    const xml = await sectionXml(buffer);
    // LEGAL portrait is 612×1008 pt (12240×20160 twips); landscape swaps w:w/w:h in the XML.
    expect(xml).toMatch(/<w:pgSz [^/>]*w:w="20160"/);
    expect(xml).toMatch(/<w:pgSz [^/>]*w:h="12240"/);
    expect(xml).toMatch(/<w:pgSz [^/>]*w:orient="landscape"/);
  });

  it("derives margins from an overridden theme padding", async () => {
    // 36 pt → 720 twips; deliberately NOT 72 pt, whose 1440 twips equals the docx library's own
    // default margin and would let this test pass without our mapping.
    const xml = await sectionXml(await renderTreeToDocx(body, { theme: { page: { padding: 36 } } }));
    expect(xml).toMatch(/<w:pgMar [^/>]*w:top="720"/);
    expect(xml).toMatch(/<w:pgMar [^/>]*w:right="720"/);
    expect(xml).toMatch(/<w:pgMar [^/>]*w:bottom="720"/);
    expect(xml).toMatch(/<w:pgMar [^/>]*w:left="720"/);
  });
});

describe("page geometry — template-level page:", () => {
  const annexed: Template = {
    template: "annex",
    version: 1,
    locale: "en",
    body: [{ paragraph: "Wide annex content." }],
    page: { size: "LEGAL", orientation: "landscape" },
  };

  it("assembles the template's page declaration onto the tree, verbatim", async () => {
    const tree = await assembleDocument(annexed);
    expect(tree.page).toEqual({ size: "LEGAL", orientation: "landscape" });
  });

  it("omits the field entirely when the template declares none", async () => {
    const tree = await assembleDocument({ template: "t", version: 1, locale: "en", body: [{ paragraph: "x" }] });
    expect(tree.page).toBeUndefined();
  });

  it("overrides the theme per-field in the PDF renderer", async () => {
    // Tree wants LEGAL; the theme's landscape (not overridden) still applies → LEGAL landscape.
    const buffer = await renderTreeToPdf(
      { body, page: { size: "LEGAL" } },
      { theme: { page: { size: "LETTER", orientation: "landscape" } } },
    );
    const [w, h] = mediaBox(buffer);
    expect(w).toBeCloseTo(PAGE_SIZES.LEGAL.height, 1);
    expect(h).toBeCloseTo(PAGE_SIZES.LEGAL.width, 1);
  });

  it("overrides the theme in the DOCX renderer", async () => {
    const buffer = await renderTreeToDocx({ body, page: { size: "TABLOID", orientation: "landscape" } });
    const xml = await (await JSZip.loadAsync(buffer)).file("word/document.xml")!.async("string");
    // TABLOID portrait is 792×1224 pt (15840×24480 twips); landscape swaps w:w/w:h.
    expect(xml).toMatch(/<w:pgSz [^/>]*w:w="24480"/);
    expect(xml).toMatch(/<w:pgSz [^/>]*w:h="15840"/);
    expect(xml).toMatch(/<w:pgSz [^/>]*w:orient="landscape"/);
  });
});

describe("page geometry — YAML file catalog", () => {
  const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name);

  it("carries a template's page: from YAML through assembly to both paged renderers", async () => {
    const catalog = await Catalog.fromDir(fixture("page-setup"));
    const template = await catalog.getTemplate("annex");
    expect(template.page).toEqual({ size: "LEGAL", orientation: "landscape" });

    const { snapshot, buffer } = await renderDocument({ catalog, template: "annex", format: "pdf", data: {} });
    expect(snapshot.tree?.page).toEqual({ size: "LEGAL", orientation: "landscape" });
    const [w, h] = mediaBox(buffer);
    expect(w).toBeCloseTo(PAGE_SIZES.LEGAL.height, 1);
    expect(h).toBeCloseTo(PAGE_SIZES.LEGAL.width, 1);

    const docx = await renderDocument({ catalog, template: "annex", format: "docx", data: {} });
    const xml = await (await JSZip.loadAsync(docx.buffer)).file("word/document.xml")!.async("string");
    expect(xml).toMatch(/<w:pgSz [^/>]*w:w="20160"/);
    expect(xml).toMatch(/<w:pgSz [^/>]*w:orient="landscape"/);
  });

  it("rejects malformed page: values with a typed authoring error", async () => {
    const catalog = await Catalog.fromDir(fixture("bad-page"));
    await expect(catalog.getTemplate("badsize")).rejects.toThrow(/page "size" must be one of A3, A4, A5/);
    await expect(catalog.getTemplate("badorient")).rejects.toThrow(/page "orientation" must be "portrait" or "landscape"/);
    await expect(catalog.getTemplate("badshape")).rejects.toThrow(/page must be an object/);
  });
});

describe("page geometry — Snapshot freezes it for deterministic re-render", () => {
  it("re-renders the frozen geometry from a snapshot", async () => {
    const catalog = Catalog.fromStore(
      new MemoryCatalogStore({
        templates: [
          {
            template: "annex",
            version: 1,
            locale: "en",
            body: [{ paragraph: "Wide annex content." }],
            page: { size: "LEGAL", orientation: "landscape" },
          },
        ],
      }),
    );
    const { snapshot } = await renderDocument({ catalog, template: "annex", format: "pdf", data: {} });
    expect(snapshot.tree?.page).toEqual({ size: "LEGAL", orientation: "landscape" });

    const { buffer } = await renderFromSnapshot(snapshot, { format: "pdf" });
    const [w, h] = mediaBox(buffer);
    expect(w).toBeCloseTo(PAGE_SIZES.LEGAL.height, 1);
    expect(h).toBeCloseTo(PAGE_SIZES.LEGAL.width, 1);

    const docx = await renderFromSnapshot(snapshot, { format: "docx" });
    const xml = await (await JSZip.loadAsync(docx.buffer)).file("word/document.xml")!.async("string");
    expect(xml).toMatch(/<w:pgSz [^/>]*w:w="20160"/);
    expect(xml).toMatch(/<w:pgSz [^/>]*w:orient="landscape"/);
  });

  it("keeps the pre-feature snapshot id for a document without page: (no digest churn)", () => {
    const snap = buildSnapshot({
      template: "nda",
      version: 1,
      locale: "en",
      payload: { party: "ACME" },
      resolved: { party: "ACME" },
      pins: [],
      tree: { body: [{ kind: "paragraph", text: "Body text." }] },
    });
    // Golden id captured on main before tree.page existed — a page-less document must not churn.
    expect(snap.id).toBe("e677112cb49eb80c");
  });

  it("perturbs the snapshot id only when a page: is declared", () => {
    const gen = {
      template: "nda",
      version: 1,
      locale: "en",
      payload: { party: "ACME" },
      resolved: { party: "ACME" },
      pins: [],
    };
    const plain = buildSnapshot({ ...gen, tree: { body: [] } });
    const paged = buildSnapshot({ ...gen, tree: { body: [], page: { orientation: "landscape" } } });
    expect(paged.id).not.toBe(plain.id);
  });
});

describe("page geometry — public surface", () => {
  it("exports the page module from the package entry point", async () => {
    const pkg = await import("../src/index");
    expect(pkg.PAGE_SIZES).toBe(PAGE_SIZES);
    expect(pkg.effectivePage).toBe(effectivePage);
  });
});
