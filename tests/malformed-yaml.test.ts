import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { FileCatalogStore } from "../src/catalog/file-catalog-store";
import { LegalDocsError } from "../src/core/errors";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "fixtures", "malformed-yaml");

describe("FileCatalogStore — malformed YAML", () => {
  const store = new FileCatalogStore(dir);

  it("wraps a syntactic YAML error in a typed LegalDocsError naming the file", async () => {
    // A raw `YAMLParseError` from the `yaml` library would otherwise escape untyped and without
    // file context — a consumer catching `LegalDocsError` must be able to catch this too.
    const err = await store.loadTemplate("broken").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LegalDocsError);
    expect((err as Error).message).toMatch(/Malformed YAML/);
    // The message points at the offending file so the author can find it.
    expect((err as Error).message).toContain("broken.yaml");
    // The underlying parser error is preserved as the cause.
    expect((err as LegalDocsError).cause).toBeInstanceOf(Error);
  });

  it("wraps a malformed clause file the same way", async () => {
    await expect(store.loadClause("greeting", 1, "en")).rejects.toThrow(LegalDocsError);
    await expect(store.loadClause("greeting", 1, "en")).rejects.toThrow(/Malformed YAML/);
  });

  // Each loader derives the `file` path differently (family dir, partials dir, extension resolution),
  // so assert every one wraps the parse error and names the right file — the wrapper is shared, but the
  // call sites are not.
  const cases: Array<{ name: string; load: () => Promise<unknown>; file: string }> = [
    { name: "template", load: () => store.loadTemplate("broken"), file: "broken.yaml" },
    { name: "include", load: () => store.loadInclude("foot"), file: "foot.yaml" },
    { name: "base", load: () => store.loadBase("fam"), file: "base.yaml" },
    { name: "variant", load: () => store.loadVariant("fam", "short"), file: "short.yaml" },
    { name: "clause", load: () => store.loadClause("greeting", 1, "en"), file: "v1.en.yaml" },
  ];
  it.each(cases)("wraps a malformed $name file and names it", async ({ load, file }) => {
    const err = await load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LegalDocsError);
    expect((err as Error).message).toMatch(/Malformed YAML/);
    expect((err as Error).message).toContain(file);
  });
});
