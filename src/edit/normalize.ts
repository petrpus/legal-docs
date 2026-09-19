/**
 * `normalizeTree` — the canonical form of a {@link DocumentTree}.
 *
 * Two trees can render identically and still differ as data: adjacent runs carrying the same marks,
 * a run of empty text, a mark list in either order, a style key explicitly set to `undefined`. A
 * WYSIWYG editor cannot represent those differences — a ProseMirror document has no empty text node
 * and joins adjacent text with equal marks on its own — so a document loaded into one and read back
 * comes out in exactly this normal form.
 *
 * That makes normalization the *contract* of the editor round trip rather than a cosmetic pass:
 * `pmDocToTree(treeToPmDoc(t))` equals `normalizeTree(t)` (proved by the demo's fast-check property,
 * #158). Outside the editor it is equally useful as a comparison form — two Edit sets that produce
 * the same document produce the same normalized tree.
 *
 * Deliberately NOT normalized: numbering (`article.no`/`level` are carried verbatim — ADR-0014 keeps
 * renumbering out of the editing layer), `custom.props` (opaque, ADR-0005 — the value is passed
 * through by reference, and the key survives even when its value is `undefined`), and page furniture
 * / page setup (not editable, carried through untouched).
 */

import type {
  BlockIndent,
  DocumentBody,
  DocumentNode,
  DocumentTree,
  KeyValueRow,
  PartyIdentification,
  SignaturePlace,
} from "../core/document-tree";
import { MARK_VALUES } from "../core/rich-text";
import type { Mark, RichParagraph, RichRun, RichTextV1 } from "../core/rich-text";

/** Canonicalize a whole tree. Pure — the input is never mutated. */
export function normalizeTree(tree: DocumentTree): DocumentTree {
  const out: DocumentTree = { body: normalizeBody(tree.body) };
  if (tree.header !== undefined) out.header = tree.header;
  if (tree.footer !== undefined) out.footer = tree.footer;
  if (tree.page !== undefined) out.page = tree.page;
  return out;
}

function normalizeBody(body: DocumentBody): DocumentBody {
  return body.map(normalizeNode);
}

function normalizeNode(node: DocumentNode): DocumentNode {
  switch (node.kind) {
    case "title":
    case "paragraph": {
      const out: Extract<DocumentNode, { kind: "title" | "paragraph" }> = { kind: node.kind, text: node.text };
      if (node.align !== undefined) out.align = node.align;
      const indent = normalizeIndent(node.indent);
      if (indent !== undefined) out.indent = indent;
      return out;
    }
    case "richText":
      return { kind: "richText", value: normalizeRichText(node.value) };
    case "article": {
      const out: Extract<DocumentNode, { kind: "article" }> = {
        kind: "article",
        no: node.no,
        level: node.level,
        body: normalizeBody(node.body),
      };
      if (node.heading !== undefined) out.heading = node.heading;
      return out;
    }
    case "numberedList":
    case "bulletList":
    case "alphaList":
      return { kind: node.kind, items: node.items.map(normalizeBody) };
    case "partyHeader":
      return { kind: "partyHeader", party: normalizeParty(node.party), roleLabel: node.roleLabel };
    case "keyValueTable":
      return { kind: "keyValueTable", rows: node.rows.map(normalizeRow) };
    case "signatures":
      return { kind: "signatures", places: node.places.map(normalizePlace) };
    case "custom":
      // `props` is opaque: passed through by reference, and the key is kept even when its value is
      // `undefined` (a component that takes no props is a valid node — ADR-0005).
      return { kind: "custom", component: node.component, props: node.props };
  }
}

/** An indent with no set side is no indent at all — the Theme default applies either way (ADR-0008). */
function normalizeIndent(indent: BlockIndent | undefined): BlockIndent | undefined {
  if (indent === undefined) return undefined;
  const out: BlockIndent = {};
  if (indent.firstLine !== undefined) out.firstLine = indent.firstLine;
  if (indent.left !== undefined) out.left = indent.left;
  return out.firstLine === undefined && out.left === undefined ? undefined : out;
}

function normalizeParty(party: PartyIdentification): PartyIdentification {
  const out: PartyIdentification = { name: party.name };
  if (party.kind !== undefined) out.kind = party.kind;
  if (party.idNumber !== undefined) out.idNumber = party.idNumber;
  if (party.address !== undefined) out.address = party.address;
  return out;
}

function normalizeRow(row: KeyValueRow): KeyValueRow {
  return { label: row.label, value: row.value };
}

function normalizePlace(place: SignaturePlace): SignaturePlace {
  const out: SignaturePlace = { name: place.name };
  if (place.role !== undefined) out.role = place.role;
  return out;
}

/**
 * Canonicalize a RichTextV1 value: empty runs dropped, adjacent runs with equal marks merged, marks
 * sorted into {@link MARK_VALUES} order and de-duplicated, and at least one (empty) run per paragraph
 * and one paragraph per document — the shapes a text block always has once it exists.
 */
export function normalizeRichText(value: RichTextV1): RichTextV1 {
  const blocks = value.blocks.map(normalizeParagraph);
  return { type: "doc", blocks: blocks.length > 0 ? blocks : [emptyParagraph()] };
}

function normalizeParagraph(paragraph: RichParagraph): RichParagraph {
  return { type: "paragraph", runs: normalizeRuns(paragraph.runs) };
}

function normalizeRuns(runs: RichRun[]): RichRun[] {
  const out: RichRun[] = [];
  for (const run of runs) {
    if (run.text === "") continue;
    const marks = canonicalMarks(run.marks);
    const previous = out[out.length - 1];
    if (previous !== undefined && sameMarks(previous.marks, marks)) {
      out[out.length - 1] = makeRun(previous.text + run.text, marks);
      continue;
    }
    out.push(makeRun(run.text, marks));
  }
  return out.length > 0 ? out : [{ text: "" }];
}

function makeRun(text: string, marks: Mark[] | undefined): RichRun {
  return marks === undefined ? { text } : { text, marks };
}

/** Marks in {@link MARK_VALUES} order, each at most once; an empty list becomes no list at all. */
function canonicalMarks(marks: Mark[] | undefined): Mark[] | undefined {
  if (marks === undefined || marks.length === 0) return undefined;
  const canonical = MARK_VALUES.filter((mark) => marks.includes(mark));
  return canonical.length > 0 ? [...canonical] : undefined;
}

function sameMarks(a: Mark[] | undefined, b: Mark[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((mark, index) => mark === b[index]);
}

function emptyParagraph(): RichParagraph {
  return { type: "paragraph", runs: [{ text: "" }] };
}
