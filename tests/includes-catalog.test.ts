import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { Catalog } from "../src/catalog/catalog";
import { expandIncludes, IncludeError } from "../src/core/includes";
import { renderDocument } from "../src/facade/render-document";

const here = path.dirname(fileURLToPath(import.meta.url));
const includesDir = path.join(here, "fixtures", "includes");
const badDir = path.join(here, "fixtures", "bad-catalog");

describe("Includes over a file catalog", () => {
  it("renders a template that includes a partial to a PDF", async () => {
    const catalog = await Catalog.fromDir(includesDir);

    const result = await renderDocument({ catalog, template: "doc", format: "pdf" });

    expect(result.buffer.length).toBeGreaterThan(500);
    expect(result.snapshotId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("expands to the same body as the inline-authored equivalent", async () => {
    const catalog = await Catalog.fromDir(includesDir);
    const withInclude = await catalog.getTemplate("doc");
    const inline = await catalog.getTemplate("doc-inline");

    const expanded = await expandIncludes(withInclude.body, (id) => catalog.loadInclude(id));

    expect(expanded).toEqual(inline.body);
  });

  it("fails fast with a path-bearing IncludeError on an unknown partial", async () => {
    const catalog = await Catalog.fromDir(badDir);

    const err = await renderDocument({ catalog, template: "unknown-include", format: "pdf" }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(IncludeError);
    expect((err as IncludeError).path).toBe("body[0]");
  });

  it("fails fast with an IncludeError on an include cycle", async () => {
    const catalog = await Catalog.fromDir(badDir);

    const err = await renderDocument({ catalog, template: "cyclic-include", format: "pdf" }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(IncludeError);
    expect((err as IncludeError).message).toMatch(/include cycle: loop-a → loop-b → loop-a/);
  });
});
