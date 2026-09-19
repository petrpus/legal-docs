import { Mark as TiptapMark, Node as TiptapNode } from "@tiptap/core";
import type { NodeViewRenderer } from "@tiptap/core";
import type { DOMOutputSpec, Node as PmNode, NodeSpec } from "prosemirror-model";
import { markSpecs, nodeSpecs } from "./pm-schema";

/**
 * The TipTap extensions, **generated from `pm-schema.ts`'s specs** rather than restated.
 *
 * TipTap builds its schema from extensions, so the obvious route is to hand-write one extension per node
 * kind — and then the editor's document model is a second, unproven copy of the one the round-trip
 * property covers. Generating them keeps a single definition: `tiptap-extensions.test.ts` pins that the
 * schema TipTap derives here is the schema `documentSchema` describes, node for node and mark for mark.
 *
 * DOM-free and React-free on purpose, so that test needs no browser environment. The React node views
 * for the atoms are passed in by `Editor.tsx`, which is where React belongs.
 */

/** The editor's own markup. It is never exported — the PDF/DOCX/HTML exporters are the library's. */
export function buildExtensions(nodeViews: Record<string, NodeViewRenderer> = {}) {
  const nodes = Object.entries(nodeSpecs).map(([name, spec]) =>
    // `text` is ProseMirror's one built-in shape: it has no attributes and renders as a DOM text node,
    // and giving it a `renderHTML` would put a content hole where a string belongs.
    name === "text" ? TiptapNode.create({ name, group: spec.group }) : nodeExtension(name, spec, nodeViews[name]),
  );
  const marks = Object.keys(markSpecs).map((name) =>
    TiptapMark.create({
      name,
      parseHTML: () => (name === "bold" ? [{ tag: "strong" }, { tag: "b" }] : [{ tag: "em" }, { tag: "i" }]),
      renderHTML: () => [name === "bold" ? "strong" : "em", 0] as DOMOutputSpec,
      addKeyboardShortcuts() {
        return { [name === "bold" ? "Mod-b" : "Mod-i"]: () => this.editor.commands.toggleMark(name) };
      },
    }),
  );
  return [...nodes, ...marks];
}

function nodeExtension(name: string, spec: NodeSpec, nodeView: NodeViewRenderer | undefined) {
  const attrs = spec.attrs ?? {};
  return TiptapNode.create({
    name,
    topNode: name === "doc",
    group: spec.group,
    content: spec.content,
    marks: spec.marks,
    atom: spec.atom,
    selectable: spec.atom === true,
    // The attributes carry document data (a party, a table's rows), not presentation: they are read
    // back out of the model by `pmDocToTree`, never re-parsed from the DOM.
    addAttributes: () =>
      Object.fromEntries(Object.keys(attrs).map((key) => [key, { default: attrs[key]?.default ?? null, rendered: false }])),
    parseHTML: () => [{ tag: `[data-kind="${name}"]` }],
    renderHTML: ({ node }) => renderNode(name, node),
    addNodeView: nodeView === undefined ? undefined : () => nodeView,
  });
}

function renderNode(name: string, node: PmNode): DOMOutputSpec {
  const tagged = (tag: string, attrs: Record<string, string> = {}): DOMOutputSpec => [tag, { "data-kind": name, ...attrs }, 0];
  switch (name) {
    case "title":
      return tagged("h1", { class: "pm-title" });
    case "paragraph":
    case "richPara":
      return tagged("p");
    case "richText":
      return tagged("div", { class: "pm-rich" });
    case "article":
      return tagged("section", {
        class: "pm-article",
        // The article's number, shown as a decoration by CSS — not a character anyone can type over.
        "data-no": String(node.attrs.no ?? ""),
        "data-level": String(node.attrs.level ?? 1),
      });
    case "articleHeading":
      return tagged("div", { class: "pm-heading" });
    case "list":
      return tagged(node.attrs.kind === "bulletList" ? "ul" : "ol", {
        class: node.attrs.kind === "alphaList" ? "pm-list pm-list--alpha" : "pm-list",
      });
    case "listItem":
      return tagged("li");
    default:
      // The atoms render through their node views; this is only the fallback markup.
      return ["div", { "data-kind": name, class: "pm-atom" }];
  }
}
