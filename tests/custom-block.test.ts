import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { Text } from "@react-pdf/renderer";
import { PDFParse } from "pdf-parse";
import { z } from "zod";
import { Catalog } from "../src/catalog/catalog";
import { assembleTree } from "../src/core/engine";
import { renderDocument } from "../src/facade/render-document";
import type { CustomBlockRegistry } from "../src/render-pdf/custom-block";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "fixtures", "custom");

const bannerSchema = z.object({ label: z.string() });
const customBlocks: CustomBlockRegistry = {
  banner: {
    schema: bannerSchema,
    pdf: (props) => createElement(Text, null, bannerSchema.parse(props).label),
  },
  // A schema-less block whose props are absent — exercises the undefined-props path.
  marker: {
    pdf: () => createElement(Text, null, "MARK"),
  },
};

async function text(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const { text } = await parser.getText();
    return text.replace(/\s+/g, " ").trim();
  } finally {
    await parser.destroy();
  }
}

describe("custom block — engine", () => {
  it("builds a custom node with deep-bound props, without a registry", async () => {
    const tree = await assembleTree(
      {
        template: "t",
        version: 1,
        locale: "en",
        body: [{ custom: { component: "banner", props: { label: "$title", fixed: "lit" } } }],
      },
      { scope: { title: "HELLO" } },
    );

    expect(tree).toEqual([
      { kind: "custom", component: "banner", props: { label: "HELLO", fixed: "lit" } },
    ]);
  });
});

describe("custom block — render", () => {
  it("renders a registered custom block into the PDF", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const { buffer } = await renderDocument({
      catalog, template: "doc", data: { title: "HELLO BANNER" }, customBlocks, format: "pdf",
    });

    expect(await text(buffer)).toContain("HELLO BANNER");
  });

  it("fails fast when the component is not registered", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    await expect(
      renderDocument({ catalog, template: "doc", data: { title: "x" }, customBlocks: {}, format: "pdf" }),
    ).rejects.toThrow(/Custom block "banner" is not registered/);
  });

  it("fails fast with a custom-block-framed error when props violate the schema", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    await expect(
      renderDocument({ catalog, template: "doc", data: { title: 123 }, customBlocks, format: "pdf" }),
    ).rejects.toThrow(/Custom block "banner" received invalid props/);
  });

  it("renders a schema-less custom block whose props are absent", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const { buffer } = await renderDocument({
      catalog, template: "doc-no-props", data: {}, customBlocks, format: "pdf",
    });

    expect(await text(buffer)).toContain("MARK");
  });
});
