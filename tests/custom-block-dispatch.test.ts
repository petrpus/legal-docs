import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { z } from "zod";
import { dispatchCustomBlock, type CustomBlockRegistry } from "../src/custom-block";
import { defaultTheme } from "../src/theme";

const theme = defaultTheme;

const noteSchema = z.object({ text: z.string() });

const blocks: CustomBlockRegistry = {
  note: {
    schema: noteSchema,
    html: (props) => `<aside>${noteSchema.parse(props).text}</aside>`,
  },
};

function ctx(overrides: Partial<Parameters<typeof dispatchCustomBlock>[2]> = {}) {
  return { blocks, theme, degradation: "placeholder" as const, ...overrides };
}

describe("dispatchCustomBlock", () => {
  it("throws on an unregistered component (hard error, not degradation)", () => {
    expect(() => dispatchCustomBlock({ component: "ghost" }, "html", ctx())).toThrow(
      /Custom block "ghost" is not registered/,
    );
  });

  it("dispatches to the format implementation with schema-validated props", () => {
    const result = dispatchCustomBlock({ component: "note", props: { text: "hi" } }, "html", ctx());
    expect(result).toEqual({ rendered: "<aside>hi</aside>" });
  });

  it("rejects schema-invalid props with the component named", () => {
    expect(() =>
      dispatchCustomBlock({ component: "note", props: { text: 42 } }, "html", ctx()),
    ).toThrow(/Custom block "note" received invalid props/);
  });

  it("returns the degradation marker for a missing format implementation (placeholder mode)", () => {
    const onDegrade = vi.fn();
    const result = dispatchCustomBlock({ component: "note" }, "docx", ctx({ onDegrade }));
    expect(result).toEqual({ marker: "[unsupported block: note in docx]" });
    expect(onDegrade).toHaveBeenCalledWith({
      component: "note",
      format: "docx",
      marker: "[unsupported block: note in docx]",
    });
  });

  it("throws for a missing format implementation in throw mode", () => {
    expect(() =>
      dispatchCustomBlock({ component: "note" }, "pdf", ctx({ degradation: "throw" })),
    ).toThrow(/Custom block "note" cannot render in "pdf"/);
  });

  it("returns the PDF implementation's element on the pdf happy path", () => {
    const element = createElement("Text", null, "hello");
    const registry: CustomBlockRegistry = { badge: { pdf: () => element } };
    const result = dispatchCustomBlock({ component: "badge" }, "pdf", ctx({ blocks: registry }));
    expect(result).toEqual({ rendered: element });
  });

  it("skips schema validation on the degradation path (no impl to feed)", () => {
    const result = dispatchCustomBlock(
      { component: "note", props: { text: 42 } },
      "docx",
      ctx({ onDegrade: vi.fn() }),
    );
    expect(result).toEqual({ marker: "[unsupported block: note in docx]" });
  });

  it("passes the theme through to the implementation context", () => {
    const seen: unknown[] = [];
    const registry: CustomBlockRegistry = {
      probe: {
        html: (_props, blockCtx) => {
          seen.push(blockCtx.theme);
          return "";
        },
      },
    };
    dispatchCustomBlock({ component: "probe" }, "html", ctx({ blocks: registry }));
    expect(seen).toEqual([theme]);
  });
});
