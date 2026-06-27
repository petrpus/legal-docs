import { describe, it, expect } from "vitest";
import { parseClauseRef } from "../src/core/clause-ref";

describe("parseClauseRef", () => {
  it("parses a pinned version", () => {
    expect(parseClauseRef("aml.intro@v2")).toEqual({ id: "aml.intro", version: 2 });
  });

  it("parses @latest", () => {
    expect(parseClauseRef("aml.intro@latest")).toEqual({ id: "aml.intro", version: "latest" });
  });

  it("treats a bare id as @latest", () => {
    expect(parseClauseRef("aml.intro")).toEqual({ id: "aml.intro", version: "latest" });
  });

  it("rejects an invalid version", () => {
    expect(() => parseClauseRef("aml.intro@2")).toThrow(/use @vN or @latest/);
  });

  it("rejects an empty id", () => {
    expect(() => parseClauseRef("@v1")).toThrow(/Invalid clause reference/);
  });
});
