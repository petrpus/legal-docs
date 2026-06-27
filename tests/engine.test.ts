import { describe, it, expect } from "vitest";
import { assembleTree } from "../src/core/engine";
import type { Template } from "../src/core/template";

describe("assembleTree", () => {
  it("maps title and paragraph body items to document nodes", () => {
    const template: Template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ title: "Hello" }, { paragraph: "World" }],
    };

    expect(assembleTree(template)).toEqual([
      { kind: "title", text: "Hello" },
      { kind: "paragraph", text: "World" },
    ]);
  });

  it("throws on an unsupported body item", () => {
    const template = {
      template: "t",
      version: 1,
      locale: "en",
      body: [{ wat: "x" }],
    } as unknown as Template;

    expect(() => assembleTree(template)).toThrow(/Unsupported body item/);
  });
});
