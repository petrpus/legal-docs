import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Catalog } from "../src/catalog/catalog";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.join(here, "fixtures", "custom-lint");

const customBlocks = {
  banner: { schema: z.object({ label: z.string() }) },
  metric: { schema: z.object({ rows: z.array(z.object({ n: z.number() })) }) },
  plain: {}, // registered, no props schema
};

describe("Custom block integrity-lint", () => {
  it("flags an unregistered component and literal props that violate the schema", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const result = await catalog.validate({ customBlocks });
    const find = (re: RegExp) => result.findings.find((f) => re.test(f.message));

    expect(result.ok).toBe(false);
    expect(find(/custom block "ghost" is not registered/)?.path).toMatch(
      /templates\/unregistered › body\[0\]/,
    );
    expect(find(/custom block "banner" props\.label: /)?.path).toMatch(
      /templates\/bad-props › body\[0\]/,
    );
  });

  it("does not flag valid literal props, $-expression props (incl. nested), no-schema or absent props", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const result = await catalog.validate({ customBlocks });

    // nested-expr proves the recursive `$`-detection: `{ rows: [{ n: "$x" }] }` is render-bound, so the
    // number-typed `n` is NOT statically rejected. ok/dynamic/no-schema/no-props must also be clean.
    const clean = ["ok", "dynamic", "nested-expr", "no-schema", "no-props"];
    const offenders = result.findings.filter((f) => clean.some((t) => f.path.startsWith(`templates/${t} `)));
    expect(offenders).toEqual([]);
  });

  it("flags every custom component as unregistered when no customBlocks are supplied", async () => {
    const catalog = await Catalog.fromDir(catalogDir);

    const result = await catalog.validate();

    // One custom item per template (7 templates).
    expect(result.findings.filter((f) => /is not registered/.test(f.message)).length).toBe(7);
  });
});
