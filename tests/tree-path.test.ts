import { describe, it, expect } from "vitest";
import { allKindsTree } from "./fixtures/all-kinds-tree";
import {
  EditError,
  formatTreePath,
  parseTreePath as p,
  transformPath,
  type EditErrorReason,
  type TreePath,
} from "../src/core/edit/tree-path";
import { locate } from "../src/core/edit/locate";
import type { DocumentTree } from "../src/core/document-tree";
import type { EditOp } from "../src/core/edit/edit-set";

/**
 * Tree paths are the addressing scheme of the editing layer (ADR-0014): an array of keys and indices
 * mirroring the tree's JSON shape, with a canonical string form. `locate` is the single definition of
 * the editable surface — every op resolves its target through it, so the editability table is pinned
 * here rather than once per op.
 */

/** The reason of the EditError `fn` is expected to throw. */
function reasonOf(fn: () => unknown): EditErrorReason {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditError) return error.reason;
    throw error;
  }
  throw new Error("expected an EditError, but nothing was thrown");
}

describe("the canonical string form", () => {
  const paths: [string, TreePath][] = [
    ["/", []],
    ["/body", ["body"]],
    ["/body/2/heading", ["body", 2, "heading"]],
    ["/body/4/rows/1/value", ["body", 4, "rows", 1, "value"]],
    ["/header/left", ["header", "left"]],
  ];

  it.each(paths)("formats %s", (text, path) => {
    expect(formatTreePath(path)).toBe(text);
  });

  it.each(paths)("parses %s", (text, path) => {
    expect(p(text)).toEqual(path);
  });

  it("rejects a path that is not rooted", () => {
    expect(reasonOf(() => p("body/0"))).toBe("invalid-path");
    expect(reasonOf(() => p(""))).toBe("invalid-path");
  });

  it("rejects an empty segment", () => {
    expect(reasonOf(() => p("/body//0"))).toBe("invalid-path");
    expect(reasonOf(() => p("/body/"))).toBe("invalid-path");
  });
});

describe("locate resolves the editable text leaves", () => {
  // The editability table, leaf by leaf: path → the value it holds and whether it may be deleted.
  const leaves: [string, string | undefined, boolean][] = [
    ["/body/0/text", "PLEDGE AGREEMENT", true],
    ["/body/1/text", "Entered into on 1 January 2026.", true],
    ["/body/3/roleLabel", "Pledgee", true],
    ["/body/3/party/name", "Acme Bank a.s.", true],
    ["/body/3/party/idNumber", "12345678", false],
    ["/body/3/party/address", "Prague", false],
    ["/body/4/party/idNumber", undefined, false],
    ["/body/5/heading", "Definitions", false],
    ["/body/5/body/0/text", "Capitalised terms have the meanings given below.", true],
    ["/body/5/body/2/items/0/0/text", "First numbered item.", true],
    ["/body/5/body/2/items/1/0/heading", "Article inside a list item", false],
    ["/body/8/rows/0/label", "Principal", true],
    ["/body/8/rows/1/value", "4.5 %", true],
    ["/body/11/places/0/name", "Acme Bank a.s.", true],
    ["/body/11/places/0/role", "Pledgee", false],
    ["/body/11/places/1/role", undefined, false],
    ["/header/left", "Pledge Agreement", false],
    ["/header/right", "Confidential", false],
    ["/footer/center", "Page 1", false],
    // A slot the furniture object does not carry is still an editable (absent) leaf.
    ["/footer/left", undefined, false],
  ];

  it.each(leaves)("%s", (text, value, required) => {
    const location = locate(allKindsTree, p(text));
    expect(location.kind).toBe("text");
    if (location.kind !== "text") return;
    expect(location.value).toBe(value);
    expect(location.required).toBe(required);
    expect(location.path).toEqual(p(text));
  });

  it("returns a live reference into the tree, not a copy", () => {
    const location = locate(allKindsTree, p("/body/8/rows/0/label"));
    if (location.kind !== "text") throw new Error("expected a text location");
    expect(location.container).toBe(allKindsTree.body[8] && (allKindsTree.body[8] as { rows: unknown[] }).rows[0]);
  });
});

describe("locate resolves the structural targets", () => {
  it("addresses the document body as a node list", () => {
    const location = locate(allKindsTree, p("/body"));
    expect(location.kind).toBe("nodeList");
    if (location.kind !== "nodeList") return;
    expect(location.list).toBe(allKindsTree.body);
  });

  it("addresses a node with its list and index", () => {
    const location = locate(allKindsTree, p("/body/0"));
    expect(location.kind).toBe("node");
    if (location.kind !== "node") return;
    expect(location.index).toBe(0);
    expect(location.node).toBe(allKindsTree.body[0]);
    expect(location.list).toBe(allKindsTree.body);
  });

  it("addresses an article body as a node list", () => {
    expect(locate(allKindsTree, p("/body/5/body")).kind).toBe("nodeList");
  });

  it("addresses a list's items, one item and a node inside it", () => {
    const items = locate(allKindsTree, p("/body/5/body/2/items"));
    expect(items.kind).toBe("listItems");
    if (items.kind === "listItems") expect(items.items).toHaveLength(2);
    expect(locate(allKindsTree, p("/body/5/body/2/items/0")).kind).toBe("nodeList");
    expect(locate(allKindsTree, p("/body/5/body/2/items/0/0")).kind).toBe("node");
  });

  it("addresses a richText value as a whole", () => {
    expect(locate(allKindsTree, p("/body/2/value")).kind).toBe("richText");
  });

  it("addresses align and indent as style targets", () => {
    const align = locate(allKindsTree, p("/body/0/align"));
    expect(align.kind).toBe("style");
    if (align.kind === "style") {
      expect(align.key).toBe("align");
      expect(align.value).toBe("center");
    }
    const indent = locate(allKindsTree, p("/body/1/indent"));
    if (indent.kind !== "style") throw new Error("expected a style location");
    expect(indent.key).toBe("indent");
    expect(indent.value).toEqual({ firstLine: 12, left: 0 });
  });

  it("addresses a whole furniture object", () => {
    const location = locate(allKindsTree, p("/header"));
    expect(location.kind).toBe("furniture");
    if (location.kind !== "furniture") return;
    expect(location.slot).toBe("header");
    expect(location.value).toBe(allKindsTree.header);
  });
});

describe("locate rejects everything outside the editable surface", () => {
  const rejections: [string, EditErrorReason][] = [
    // Frozen by the editability table.
    ["/", "not-editable"],
    ["/page", "not-editable"],
    ["/page/size", "not-editable"],
    ["/body/0/kind", "not-editable"],
    ["/body/5/no", "not-editable"],
    ["/body/5/level", "not-editable"],
    ["/body/9/props", "not-editable"],
    ["/body/9/component", "not-editable"],
    ["/body/3/party/kind", "not-editable"],
    ["/body/3/party", "not-editable"],
    ["/body/8/rows", "not-editable"],
    ["/body/8/rows/0", "not-editable"],
    ["/body/11/places/0", "not-editable"],
    // Keys that exist on another node kind, or nowhere at all.
    ["/body/0/heading", "wrong-kind"],
    ["/body/11/rows", "wrong-kind"],
    ["/body/0/bogus", "unknown-key"],
    ["/bogus", "unknown-key"],
    ["/header/bogus", "unknown-key"],
    // Indices outside their list.
    ["/body/99", "out-of-range"],
    ["/body/8/rows/9/label", "out-of-range"],
    ["/body/5/body/2/items/7/0", "out-of-range"],
    // Segments of the wrong sort, or a path continuing past a leaf.
    ["/body/text", "invalid-path"],
    ["/body/0/1", "invalid-path"],
    ["/body/0/text/0", "invalid-path"],
    ["/body/0/align/left", "invalid-path"],
  ];

  it.each(rejections)("%s → %s", (text, reason) => {
    expect(reasonOf(() => locate(allKindsTree, p(text)))).toBe(reason);
  });

  it("names the path in the message", () => {
    try {
      locate(allKindsTree, p("/body/5/no"));
      throw new Error("expected an EditError");
    } catch (error) {
      expect(error).toBeInstanceOf(EditError);
      const failure = error as EditError;
      expect(failure.message).toContain("/body/5/no");
      expect(failure.path).toEqual(["body", 5, "no"]);
      expect(failure.opIndex).toBeUndefined();
    }
  });

  it("reports an absent furniture object rather than inventing one", () => {
    const bare: DocumentTree = { body: [] };
    expect(reasonOf(() => locate(bare, p("/header/left")))).toBe("missing");
  });
});

describe("transformPath shifts a path through a structural op", () => {
  const insert: EditOp = { op: "insertNode", path: ["body", 1], node: { kind: "paragraph", text: "new" } };
  const remove: EditOp = { op: "removeNode", path: ["body", 1] };
  const move: EditOp = { op: "moveNode", from: ["body", 0], to: ["body", 2] };
  const insertItem: EditOp = { op: "insertListItem", path: ["body", 6, "items", 0], item: [{ kind: "paragraph", text: "new" }] };
  const removeItem: EditOp = { op: "removeListItem", path: ["body", 6, "items", 0] };

  it("shifts later siblings of an inserted node", () => {
    expect(transformPath(["body", 0], insert)).toEqual(["body", 0]);
    expect(transformPath(["body", 1], insert)).toEqual(["body", 2]);
    expect(transformPath(["body", 2, "text"], insert)).toEqual(["body", 3, "text"]);
    expect(transformPath(["header", "left"], insert)).toEqual(["header", "left"]);
    // A different parent list is untouched.
    expect(transformPath(["body", 0, "body", 1], insert)).toEqual(["body", 0, "body", 1]);
  });

  it("drops a removed path and pulls later siblings back", () => {
    expect(transformPath(["body", 1], remove)).toBeNull();
    expect(transformPath(["body", 1, "text"], remove)).toBeNull();
    expect(transformPath(["body", 2], remove)).toEqual(["body", 1]);
    expect(transformPath(["body", 0], remove)).toEqual(["body", 0]);
  });

  it("follows a moved node and rebases its siblings", () => {
    expect(transformPath(["body", 0, "text"], move)).toEqual(["body", 2, "text"]);
    expect(transformPath(["body", 1], move)).toEqual(["body", 0]);
    expect(transformPath(["body", 2], move)).toEqual(["body", 1]);
  });

  it("shifts list items the same way", () => {
    expect(transformPath(["body", 6, "items", 0, 0, "text"], insertItem)).toEqual(["body", 6, "items", 1, 0, "text"]);
    expect(transformPath(["body", 6, "items"], insertItem)).toEqual(["body", 6, "items"]);
    expect(transformPath(["body", 6, "items", 0, 0], removeItem)).toBeNull();
    expect(transformPath(["body", 6, "items", 1], removeItem)).toEqual(["body", 6, "items", 0]);
  });

  it("leaves a path untouched for a non-structural op", () => {
    const setText: EditOp = { op: "setText", path: ["body", 0, "text"], value: "x" };
    expect(transformPath(["body", 3], setText)).toEqual(["body", 3]);
  });
});
