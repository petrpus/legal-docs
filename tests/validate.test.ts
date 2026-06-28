import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { Catalog } from "../src/catalog/catalog";

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleDir = path.join(here, "..", "legal-docs");
const badDir = path.join(here, "fixtures", "bad-catalog");

describe("Catalog.validate", () => {
  it("passes on the sample catalog (with its derivations registered)", async () => {
    const catalog = await Catalog.fromDir(sampleDir);

    const result = await catalog.validate({
      derivations: {
        counterpartsCount: () => 1,
        securityClause: () => "counterparts@v1",
      },
    });

    expect(result).toEqual({ ok: true, findings: [] });
  });

  it("reports unresolved clauses, unregistered helpers, and var type mismatches with paths", async () => {
    const catalog = await Catalog.fromDir(badDir);

    const result = await catalog.validate();

    expect(result.ok).toBe(false);
    const find = (re: RegExp) => result.findings.find((f) => re.test(f.message));

    expect(find(/clause "missing-clause@v1" does not resolve/)?.path).toMatch(
      /templates\/broken › body\[0\]/,
    );
    expect(find(/helper "ohno" is not registered/)?.path).toMatch(/templates\/broken › body\[1\]/);
    expect(find(/var "count": expected a integer/)?.path).toMatch(/templates\/broken › body\[2\]/);
  });

  it("reports an id/filename mismatch and an unregistered derivation", async () => {
    const catalog = await Catalog.fromDir(badDir);

    const result = await catalog.validate();
    const find = (re: RegExp) => result.findings.find((f) => re.test(f.message));

    expect(find(/template id "not-mismatch" does not match its file name "mismatch"/)?.path).toBe(
      "templates/mismatch",
    );
    expect(find(/derivation "missingDerivation" is not registered/)?.path).toMatch(
      /templates\/mismatch › derivations/,
    );
  });

  it("reports unresolved and cyclic includes as findings", async () => {
    const catalog = await Catalog.fromDir(badDir);

    const result = await catalog.validate();
    const find = (re: RegExp) => result.findings.find((f) => re.test(f.message));

    expect(find(/include "ghost" does not resolve/)?.path).toMatch(
      /templates\/unknown-include › body\[0\]/,
    );
    expect(find(/include cycle: loop-a → loop-b → loop-a/)?.path).toMatch(
      /templates\/cyclic-include › body\[0\]/,
    );
  });
});
