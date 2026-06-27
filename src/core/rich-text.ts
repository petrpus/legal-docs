/**
 * RichTextV1 — the renderer-agnostic rich-text model used by Clause bodies and `richText` nodes.
 * Authors write a markdown-subset (paragraphs separated by a blank line, `**bold**`, `*italic*`),
 * which `parseRichText` turns into this structure. Marks grow as documents need them.
 */
export type Mark = "bold" | "italic";

export interface RichRun {
  text: string;
  marks?: Mark[];
}

export interface RichParagraph {
  type: "paragraph";
  runs: RichRun[];
}

export interface RichTextV1 {
  type: "doc";
  blocks: RichParagraph[];
}

const INLINE = /\*\*(.+?)\*\*|\*(.+?)\*/g;

/** Parse the markdown-subset source into RichTextV1. */
export function parseRichText(source: string): RichTextV1 {
  const paragraphs = source
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);

  const blocks: RichParagraph[] = paragraphs.map((p) => ({
    type: "paragraph",
    runs: parseInline(p),
  }));

  return { type: "doc", blocks: blocks.length > 0 ? blocks : [emptyParagraph()] };
}

function parseInline(text: string): RichRun[] {
  const runs: RichRun[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index) });
    if (match[1] !== undefined) runs.push({ text: match[1], marks: ["bold"] });
    else if (match[2] !== undefined) runs.push({ text: match[2], marks: ["italic"] });
    last = INLINE.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length > 0 ? runs : [{ text: "" }];
}

function emptyParagraph(): RichParagraph {
  return { type: "paragraph", runs: [{ text: "" }] };
}
