import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { Catalog } from "../src/catalog/catalog";

const here = path.dirname(fileURLToPath(import.meta.url));
const familyDir = path.join(here, "fixtures", "family");
const badDir = path.join(here, "fixtures", "bad-catalog");

describe("Variant composition over a file catalog", () => {
  it("composes a Variant whose body equals a hand-written standalone equivalent", async () => {
    const catalog = await Catalog.fromDir(familyDir);

    const composed = await catalog.getTemplate("greet", "two-party");
    const inline = await catalog.getTemplate("greet-two-inline");

    expect(composed.body).toEqual(inline.body);
    expect(composed).toMatchObject({
      template: "greet",
      version: 2,
      variant: "two-party",
      parties: ["lender", "pledgor"],
    });
  });

  it("composes a different Variant of the same family independently", async () => {
    const catalog = await Catalog.fromDir(familyDir);

    const three = await catalog.getTemplate("greet", "three-party");

    expect(three.variant).toBe("three-party");
    expect(three.parties).toEqual(["lender", "pledgor", "accessionDebtor"]);
    expect(three.body).toContainEqual({ paragraph: "Three-party intro" });
  });

  it("lists families and their variants", async () => {
    const catalog = await Catalog.fromDir(familyDir);

    expect(await catalog.familyIds()).toEqual(["greet"]);
    expect((await catalog.variantIds("greet")).sort()).toEqual(["three-party", "two-party"]);
  });

  it("excludes family directories from standalone template ids", async () => {
    const catalog = await Catalog.fromDir(familyDir);

    expect(await catalog.templateIds()).toEqual(["greet-two-inline"]);
  });

  it("fails fast with a clear error for an unknown variant", async () => {
    const catalog = await Catalog.fromDir(familyDir);

    await expect(catalog.getTemplate("greet", "ghost")).rejects.toThrow(/not found in family "greet"/);
  });

  it("passes validate on a clean family catalog", async () => {
    const catalog = await Catalog.fromDir(familyDir);

    expect(await catalog.validate()).toEqual({ ok: true, findings: [] });
  });

  it("reports undeclared-slot overrides and extends mismatches as findings", async () => {
    const catalog = await Catalog.fromDir(badDir);

    const result = await catalog.validate();
    const find = (re: RegExp) => result.findings.find((f) => re.test(f.message));

    expect(result.ok).toBe(false);
    expect(find(/overrides slot "ghostslot", which base "badfam" does not declare/)?.path).toBe(
      "templates/badfam › undeclared",
    );
    expect(find(/extends "some-other-family" but the base is "badfam"/)?.path).toBe(
      "templates/badfam › wrongbase",
    );
  });

  it("flags a Slot that survives into a standalone template body", async () => {
    const catalog = await Catalog.fromDir(badDir);

    const result = await catalog.validate();
    const find = (re: RegExp) => result.findings.find((f) => re.test(f.message));

    expect(find(/unfilled slot "orphan"/)?.path).toMatch(/templates\/stray-slot › body\[1\]/);
  });
});
