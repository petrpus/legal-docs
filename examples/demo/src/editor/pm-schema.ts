import { Schema } from "prosemirror-model";
import type { Node as PmNode, NodeSpec } from "prosemirror-model";
import { normalizeTree } from "@petrpus/legal-docs/edit";
import type {
  Align,
  BlockIndent,
  DocumentNode,
  DocumentTree,
  KeyValueRow,
  Mark,
  PageFurniture,
  PartyIdentification,
  RichRun,
  RichTextV1,
  SignaturePlace,
} from "@petrpus/legal-docs/edit";

/**
 * The ProseMirror model of a `DocumentTree` — the demo's WYSIWYG half (#158), DOM-free and
 * TipTap-free: `prosemirror-model` only, so this module is a pure data mapping that can be tested in
 * Node. The editor shell (#159) layers TipTap on top of it.
 *
 * It lives in the **demo**, never in `src/**`: the library's editing subpath stays editor-agnostic
 * (ADR-0014), and `tests/edit-browser-safety.test.ts` fails the build if a ProseMirror import ever
 * appears under `src/`. What the library does provide is the canonical form both ends agree on —
 * `normalizeTree`, which is why `pmDocToTree(treeToPmDoc(t))` is `normalizeTree(t)` and not `t`.
 *
 * Mapping, kind by kind:
 * - `title` / `paragraph` — mark-free text blocks (`marks: ""`), styling on `align`/`indent` attrs.
 * - `richText` — a `richText` block of `richPara+`, whose text carries the `bold`/`italic` marks.
 * - `article` — an optional `articleHeading` child plus its body; `no` is a read-only attr and
 *   `level` is *derived from nesting depth* on the way back, never trusted from the attr.
 * - lists — one `list` node attributed with the Core kind, holding `listItem`s of blocks.
 * - `partyHeader` / `keyValueTable` / `signatures` / `custom` — atoms whose attrs hold their data
 *   verbatim; the editor renders them through node views (a form), never as editable text.
 * - `header` / `footer` / `page` — not editable at all: parked on the doc's attrs and handed back.
 */

const blockAttrs = { align: { default: null }, indent: { default: null } };

const nodes: Record<string, NodeSpec> = {
  // Page furniture and page geometry are not part of the editable document; they ride along here so
  // the editor can hand back a whole DocumentTree rather than only its body.
  doc: { content: "block*", attrs: { header: { default: null }, footer: { default: null }, page: { default: null } } },
  text: { group: "inline" },

  title: { group: "block", content: "text*", marks: "", attrs: blockAttrs },
  paragraph: { group: "block", content: "text*", marks: "", attrs: blockAttrs },

  richText: { group: "block", content: "richPara+" },
  richPara: { content: "text*", marks: "bold italic" },

  article: { group: "block", content: "articleHeading? block*", attrs: { no: { default: "" }, level: { default: 1 } } },
  articleHeading: { content: "text*", marks: "" },

  list: { group: "block", content: "listItem*", attrs: { kind: { default: "numberedList" } } },
  listItem: { content: "block*" },

  partyHeader: { group: "block", atom: true, attrs: { party: { default: null }, roleLabel: { default: "" } } },
  keyValueTable: { group: "block", atom: true, attrs: { rows: { default: null } } },
  signatures: { group: "block", atom: true, attrs: { places: { default: null } } },
  // `props` is opaque and may legitimately be `undefined`, which ProseMirror would replace with the
  // attribute's default — so the payload is wrapped in an object that never is.
  custom: { group: "block", atom: true, attrs: { component: { default: "" }, payload: { default: null } } },
};

/** Mark order here is the rank ProseMirror sorts by, and it matches the library's `MARK_VALUES`. */
const marks = { bold: {}, italic: {} };

export const documentSchema = new Schema({ nodes, marks });

/** The `list` node's attr — the Core list kinds, minus the `List` suffix nothing needs here. */
type ListKind = Extract<DocumentNode, { items: unknown }>["kind"];

interface CustomPayload {
  props: unknown;
}

/**
 * Load a document into the editor model. The tree is normalized first: that *is* the shape a
 * ProseMirror document can hold, so normalizing here (rather than asking every caller to) is what
 * makes the mapping total.
 */
export function treeToPmDoc(tree: DocumentTree): PmNode {
  const normalized = normalizeTree(tree);
  return documentSchema.topNodeType.createChecked(
    {
      header: normalized.header ?? null,
      footer: normalized.footer ?? null,
      page: normalized.page ?? null,
    },
    normalized.body.map(nodeToPm),
  );
}

function nodeToPm(node: DocumentNode): PmNode {
  const type = documentSchema.nodes;
  switch (node.kind) {
    case "title":
    case "paragraph":
      return type[node.kind].createChecked(
        { align: node.align ?? null, indent: node.indent ?? null },
        textNodes(node.text),
      );
    case "richText":
      return type.richText.createChecked(
        null,
        node.value.blocks.map((block) => type.richPara.createChecked(null, block.runs.flatMap(runToPm))),
      );
    case "article": {
      const children = node.heading === undefined ? [] : [type.articleHeading.createChecked(null, textNodes(node.heading))];
      return type.article.createChecked({ no: node.no, level: node.level }, [...children, ...node.body.map(nodeToPm)]);
    }
    case "numberedList":
    case "bulletList":
    case "alphaList":
      return type.list.createChecked(
        { kind: node.kind },
        node.items.map((item) => type.listItem.createChecked(null, item.map(nodeToPm))),
      );
    case "partyHeader":
      return type.partyHeader.createChecked({ party: node.party, roleLabel: node.roleLabel });
    case "keyValueTable":
      return type.keyValueTable.createChecked({ rows: node.rows });
    case "signatures":
      return type.signatures.createChecked({ places: node.places });
    case "custom": {
      const payload: CustomPayload = { props: node.props };
      return type.custom.createChecked({ component: node.component, payload });
    }
  }
}

/** ProseMirror has no empty text node — an empty string is a block with no children. */
function textNodes(text: string): PmNode[] {
  return text === "" ? [] : [documentSchema.text(text)];
}

function runToPm(run: RichRun): PmNode[] {
  if (run.text === "") return [];
  const applied = (run.marks ?? []).map((mark) => documentSchema.marks[mark].create());
  return [documentSchema.text(run.text, applied)];
}

/** Read the editor model back out as a `DocumentTree` in canonical form. */
export function pmDocToTree(doc: PmNode): DocumentTree {
  const out: DocumentTree = { body: childrenToBody(doc, 0) };
  const header = doc.attrs.header as PageFurniture | null;
  const footer = doc.attrs.footer as PageFurniture | null;
  const page = doc.attrs.page as DocumentTree["page"] | null;
  if (header !== null) out.header = header;
  if (footer !== null) out.footer = footer;
  if (page != null) out.page = page;
  return out;
}

/** `depth` is the number of enclosing articles — the only thing an article's `level` is read from. */
function childrenToBody(parent: PmNode, depth: number): DocumentNode[] {
  const body: DocumentNode[] = [];
  parent.forEach((child) => {
    body.push(pmToNode(child, depth));
  });
  return body;
}

function pmToNode(node: PmNode, depth: number): DocumentNode {
  switch (node.type.name) {
    case "title":
    case "paragraph": {
      const out: Extract<DocumentNode, { kind: "title" | "paragraph" }> = {
        kind: node.type.name,
        text: node.textContent,
      };
      const align = node.attrs.align as Align | null;
      const indent = node.attrs.indent as BlockIndent | null;
      if (align !== null) out.align = align;
      if (indent !== null) out.indent = indent;
      return out;
    }
    case "richText": {
      const blocks: RichTextV1["blocks"] = [];
      node.forEach((paragraph) => {
        blocks.push({ type: "paragraph", runs: pmToRuns(paragraph) });
      });
      return { kind: "richText", value: { type: "doc", blocks } };
    }
    case "article": {
      const first = node.firstChild;
      const hasHeading = first !== null && first.type.name === "articleHeading";
      const out: Extract<DocumentNode, { kind: "article" }> = {
        kind: "article",
        no: node.attrs.no as string,
        // Derived, not read back: the editor may move an article, and its depth is the truth.
        level: depth + 1,
        body: [],
      };
      if (hasHeading) out.heading = first.textContent;
      const body: DocumentNode[] = [];
      node.forEach((child, _offset, index) => {
        if (hasHeading && index === 0) return;
        body.push(pmToNode(child, depth + 1));
      });
      out.body = body;
      return out;
    }
    case "list": {
      const items: DocumentNode[][] = [];
      node.forEach((item) => {
        items.push(childrenToBody(item, depth));
      });
      return { kind: node.attrs.kind as ListKind, items };
    }
    case "partyHeader":
      return {
        kind: "partyHeader",
        party: node.attrs.party as PartyIdentification,
        roleLabel: node.attrs.roleLabel as string,
      };
    case "keyValueTable":
      return { kind: "keyValueTable", rows: node.attrs.rows as KeyValueRow[] };
    case "signatures":
      return { kind: "signatures", places: node.attrs.places as SignaturePlace[] };
    case "custom": {
      const payload = node.attrs.payload as CustomPayload;
      return { kind: "custom", component: node.attrs.component as string, props: payload.props };
    }
    default:
      throw new Error(`pmDocToTree: unexpected node type "${node.type.name}"`);
  }
}

/** A `richPara` with no children is the empty paragraph the normal form keeps as one empty run. */
function pmToRuns(paragraph: PmNode): RichRun[] {
  const runs: RichRun[] = [];
  paragraph.forEach((child) => {
    const applied = child.marks.map((mark) => mark.type.name as Mark);
    runs.push(applied.length > 0 ? { text: child.text ?? "", marks: applied } : { text: child.text ?? "" });
  });
  return runs.length > 0 ? runs : [{ text: "" }];
}

/** The article number is presented read-only in the editor — renumbering is out of scope (ADR-0014). */
export function isReadOnlyAttr(nodeType: string, attr: string): boolean {
  return nodeType === "article" && (attr === "no" || attr === "level");
}
