import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { renderTree, type RenderFormat } from "../src/facade/render-tree";
import { Catalog } from "../src/catalog/catalog";
import { renderDocument } from "../src/facade/render-document";
import { renderFromSnapshot } from "../src/facade/render-from-snapshot";
import type { DocumentTree } from "../src/core/document-tree";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = (name: string) => path.join(here, "fixtures", name);

const tree: DocumentTree = { body: [{ kind: "title", text: "Hi" }] };

describe("renderTree", () => {
  it("renders html as a format-discriminated string result", async () => {
    const result = await renderTree(tree, "html", {});
    expect(result.format).toBe("html");
    if (result.format !== "html") throw new Error("expected html");
    expect(result.html).toContain("Hi");
  });

  it("renders pdf as a buffer + stream result", async () => {
    const result = await renderTree(tree, "pdf", {});
    expect(result.format).toBe("pdf");
    if (result.format !== "pdf") throw new Error("expected pdf");
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.stream).toBeInstanceOf(Readable);
  });

  it("renders docx as a buffer + stream result", async () => {
    const result = await renderTree(tree, "docx", {});
    expect(result.format).toBe("docx");
    if (result.format !== "docx") throw new Error("expected docx");
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.stream).toBeInstanceOf(Readable);
  });

  it("rejects an unknown format at runtime (untyped JS callers)", async () => {
    await expect(renderTree(tree, "xml" as unknown as RenderFormat, {})).rejects.toThrow(
      /Unsupported format: xml/,
    );
  });
});

describe("fresh render ≡ pins re-render", () => {
  it("produces identical HTML for the same inputs through both paths", async () => {
    const catalog = await Catalog.fromDir(dir("snapshot-v1"));
    const fresh = await renderDocument({
      catalog,
      template: "doc",
      data: {},
      format: "html",
      snapshotMode: "pins",
    });
    const re = await renderFromSnapshot(fresh.snapshot, { catalog, format: "html" });
    expect(re.html).toEqual(fresh.html);
  });
});
