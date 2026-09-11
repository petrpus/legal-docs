import { describe, it, expect } from "vitest";
import { parseRichText, richTextToMarkdown, type RichTextV1 } from "../src/core/rich-text";

describe("parseRichText", () => {
  it("splits paragraphs on a blank line", () => {
    const doc = parseRichText("First para.\n\nSecond para.");
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0]?.runs).toEqual([{ text: "First para." }]);
    expect(doc.blocks[1]?.runs).toEqual([{ text: "Second para." }]);
  });

  it("parses bold and italic marks", () => {
    const doc = parseRichText("A **bold** and *italic* word.");
    expect(doc.blocks[0]?.runs).toEqual([
      { text: "A " },
      { text: "bold", marks: ["bold"] },
      { text: " and " },
      { text: "italic", marks: ["italic"] },
      { text: " word." },
    ]);
  });

  it("collapses internal whitespace from wrapped lines", () => {
    const doc = parseRichText("One\n  two   three.");
    expect(doc.blocks[0]?.runs).toEqual([{ text: "One two three." }]);
  });

  it("yields a single empty paragraph for empty or whitespace input", () => {
    expect(parseRichText("")).toEqual({
      type: "doc",
      blocks: [{ type: "paragraph", runs: [{ text: "" }] }],
    });
    expect(parseRichText("   \n\n  ").blocks).toHaveLength(1);
  });

  it("leaves unbalanced marks as literal text", () => {
    expect(parseRichText("**bold").blocks[0]?.runs).toEqual([{ text: "**bold" }]);
    expect(parseRichText("a * b").blocks[0]?.runs).toEqual([{ text: "a * b" }]);
  });
});

describe("richTextToMarkdown", () => {
  /** Sources already in the normal form `parseRichText` produces (single spaces, blank-line breaks). */
  const sources = [
    "",
    "Plain text.",
    "A **bold** word.",
    "An *italic* word.",
    "**Bold** at the start and *italic* at the end.",
    "First para.\n\nSecond para.",
    "**Only bold.**",
  ];

  it.each(sources)("is the inverse of parseRichText for %j", (source) => {
    expect(richTextToMarkdown(parseRichText(source))).toBe(source);
  });

  it("round-trips a value back through the parser", () => {
    const value: RichTextV1 = {
      type: "doc",
      blocks: [
        { type: "paragraph", runs: [{ text: "A " }, { text: "bold", marks: ["bold"] }, { text: " word." }] },
        { type: "paragraph", runs: [{ text: "Second." }] },
      ],
    };

    expect(parseRichText(richTextToMarkdown(value))).toEqual(value);
  });

  it("separates paragraphs with a blank line and marks a run once", () => {
    const value: RichTextV1 = {
      type: "doc",
      blocks: [
        { type: "paragraph", runs: [{ text: "One", marks: ["italic"] }] },
        { type: "paragraph", runs: [{ text: "Two", marks: ["bold"] }] },
      ],
    };

    expect(richTextToMarkdown(value)).toBe("*One*\n\n**Two**");
  });
});
