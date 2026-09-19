import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { documentSchema, pmDocToTree, treeToPmDoc } from "./pm-schema";
import { buildExtensions } from "./tiptap-extensions";
import type { DocumentTree } from "@petrpus/legal-docs/edit";

/**
 * The editor's schema and the mapped schema are the same schema. If they ever drift, the WYSIWYG would
 * be editing a document the round-trip property does not cover — which is the one way this demo could
 * quietly lose data. Derived here with TipTap's own `getSchema`, no browser needed.
 */

const tiptapSchema = getSchema(buildExtensions());

const tree: DocumentTree = {
  header: { center: "Confidential" },
  body: [
    { kind: "title", text: "Service Agreement", align: "center" },
    { kind: "partyHeader", party: { name: "Acme s.r.o." }, roleLabel: "Provider" },
    { kind: "keyValueTable", rows: [{ label: "Term", value: "12 months" }] },
    {
      kind: "richText",
      value: { type: "doc", blocks: [{ type: "paragraph", runs: [{ text: "Bold", marks: ["bold", "italic"] }] }] },
    },
    {
      kind: "article",
      no: "1",
      level: 1,
      heading: "Scope",
      body: [
        { kind: "paragraph", text: "Body." },
        { kind: "bulletList", items: [[{ kind: "paragraph", text: "Item" }]] },
        { kind: "custom", component: "qr-code", props: { value: "x" } },
      ],
    },
    { kind: "signatures", places: [{ name: "Jane Roe", role: "Director" }] },
  ],
};

describe("the TipTap extensions derive the mapped schema", () => {
  it("declares the same nodes and marks, in the same order", () => {
    expect(Object.keys(tiptapSchema.nodes)).toEqual(Object.keys(documentSchema.nodes));
    // Mark rank is the order ProseMirror sorts a run's marks in — the normal form depends on it.
    expect(Object.keys(tiptapSchema.marks)).toEqual(Object.keys(documentSchema.marks));
    expect(tiptapSchema.topNodeType.name).toBe(documentSchema.topNodeType.name);
  });

  it("declares the same content, groups, atoms and allowed marks per node", () => {
    for (const [name, type] of Object.entries(documentSchema.nodes)) {
      const mirror = tiptapSchema.nodes[name]!;
      expect([name, mirror.spec.content]).toEqual([name, type.spec.content]);
      expect([name, mirror.spec.group]).toEqual([name, type.spec.group]);
      expect([name, mirror.isAtom]).toEqual([name, type.isAtom]);
      expect([name, Object.keys(mirror.spec.attrs ?? {})]).toEqual([name, Object.keys(type.spec.attrs ?? {})]);
      for (const mark of Object.values(documentSchema.marks)) {
        expect([name, mark.name, mirror.allowsMarkType(tiptapSchema.marks[mark.name]!)]).toEqual([
          name,
          mark.name,
          type.allowsMarkType(mark),
        ]);
      }
    }
  });

  it("holds the documents the mapping produces, attributes and all", () => {
    const doc = treeToPmDoc(tree);
    // What `useEditor` does with the content it is handed: rebuild it under the editor's own schema.
    const loaded = tiptapSchema.nodeFromJSON(doc.toJSON());
    expect(() => loaded.check()).not.toThrow();
    expect(pmDocToTree(loaded)).toEqual(pmDocToTree(doc));
  });
});
