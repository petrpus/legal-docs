import { describe, it, expect } from "vitest";
import { Catalog } from "../src/catalog/catalog";
import { MemoryCatalogStore } from "../src/catalog/memory-catalog-store";
import { LegalDocsError, NotFoundError } from "../src/core/errors";
import { PublishValidationError } from "../src/catalog/editing-facade";
import { SnapshotError } from "../src/core/snapshot";
import { CompositionError } from "../src/core/compose";
import type { Clause } from "../src/core/clause";

const clause = (version: number): Clause => ({ clause: "c", version, locale: "en", vars: {}, text: "t" });

describe("error taxonomy", () => {
  it("every library error extends LegalDocsError (one base to catch)", () => {
    expect(new NotFoundError("template", { id: "x" })).toBeInstanceOf(LegalDocsError);
    expect(new PublishValidationError([])).toBeInstanceOf(LegalDocsError);
    expect(new SnapshotError("x")).toBeInstanceOf(LegalDocsError);
    expect(new CompositionError("x")).toBeInstanceOf(LegalDocsError);
  });

  it("a not-found element throws a NotFoundError with a structured kind + ref", async () => {
    const cat = Catalog.fromStore(new MemoryCatalogStore());
    await expect(cat.getTemplate("ghost")).rejects.toBeInstanceOf(NotFoundError);
    try {
      await cat.getTemplate("ghost");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundError);
      const nf = e as NotFoundError;
      expect(nf.kind).toBe("template");
      expect(nf.ref).toEqual({ id: "ghost" });
      expect(nf).toBeInstanceOf(LegalDocsError); // also catchable as the base
    }
  });

  it("reports the ref precisely per kind", async () => {
    const cat = Catalog.fromStore(
      new MemoryCatalogStore({ clauses: [clause(1)], families: [{ base: { base: "fam", version: 1, locale: "en", body: [] } }] }),
    );
    const grab = async (fn: () => Promise<unknown>): Promise<NotFoundError> => {
      try {
        await fn();
      } catch (e) {
        return e as NotFoundError;
      }
      throw new Error("expected a throw");
    };
    expect((await grab(() => cat.getClause("c@v9", "en"))).ref).toEqual({ id: "c", version: 9 });
    expect((await grab(() => cat.getClause("ghost@latest", "en"))).kind).toBe("clause");
    expect((await grab(() => cat.getTemplate("fam", "nope"))).kind).toBe("variant");
  });
});
