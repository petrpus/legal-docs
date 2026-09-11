import { describe, it, expect } from "vitest";
import { assertValidTree, documentNodeKinds, TreeValidationError } from "../src/core/document-tree-schema";
import { DOCUMENT_NODE_KINDS, isDocumentNodeKind } from "../src/core/document-tree";
import { allKindsTree } from "./fixtures/all-kinds-tree";

/** Run `assertValidTree` and return the error it threw (failing the test if it accepted the value). */
function reject(value: unknown): TreeValidationError {
  try {
    assertValidTree(value);
  } catch (e) {
    if (e instanceof TreeValidationError) return e;
    throw e;
  }
  throw new Error("expected assertValidTree to throw");
}

describe("assertValidTree", () => {
  it("accepts a tree using every node kind, nested articles, lists and furniture", () => {
    expect(() => assertValidTree(allKindsTree)).not.toThrow();
  });

  it("accepts a minimal tree and tolerates an unknown additive field", () => {
    expect(() => assertValidTree({ body: [] })).not.toThrow();
    // Snapshots are long-lived: a tree written by a newer build must still validate here.
    expect(() => assertValidTree({ body: [{ kind: "paragraph", text: "x", futureField: 1 }] })).not.toThrow();
  });

  it("rejects an unknown node kind, naming its position", () => {
    const err = reject({ body: [{ kind: "paragraph", text: "ok" }, { kind: "footnote", text: "?" }] });
    expect(err.name).toBe("TreeValidationError");
    expect(err.issues[0]?.path).toEqual(["body", 1, "kind"]);
    expect(err.message).toMatch(/^body\.1\.kind: /);
  });

  it("rejects a bad align value at its path", () => {
    const err = reject({ body: [{ kind: "title", text: "T", align: "middle" }] });
    expect(err.issues[0]?.path).toEqual(["body", 0, "align"]);
  });

  it("rejects a negative and a NaN indent", () => {
    expect(reject({ body: [{ kind: "paragraph", text: "x", indent: { left: -4 } }] }).issues[0]?.path).toEqual([
      "body",
      0,
      "indent",
      "left",
    ]);
    expect(reject({ body: [{ kind: "paragraph", text: "x", indent: { firstLine: NaN } }] }).issues[0]?.path).toEqual([
      "body",
      0,
      "indent",
      "firstLine",
    ]);
  });

  it("rejects a richText value with the wrong document type", () => {
    const err = reject({ body: [{ kind: "richText", value: { type: "document", blocks: [] } }] });
    expect(err.issues[0]?.path).toEqual(["body", 0, "value", "type"]);
  });

  it("rejects an article with no body, deep inside the tree", () => {
    const err = reject({
      body: [{ kind: "article", no: "1", level: 1, body: [{ kind: "article", no: "1.1", level: 2 }] }],
    });
    expect(err.issues[0]?.path).toEqual(["body", 0, "body", 0, "body"]);
  });

  it("rejects a bare DocumentNode[] — callers normalize with asDocumentTree first", () => {
    expect(reject([{ kind: "paragraph", text: "x" }]).issues[0]?.path).toEqual([]);
  });

  it("checks only `component` on a custom node, leaving `props` opaque", () => {
    expect(() => assertValidTree({ body: [{ kind: "custom", component: "qr", props: { any: ["thing"] } }] })).not.toThrow();
    expect(reject({ body: [{ kind: "custom", component: 42, props: {} }] }).issues[0]?.path).toEqual([
      "body",
      0,
      "component",
    ]);
  });

  it("rejects malformed page furniture and page setup", () => {
    expect(reject({ body: [], header: { center: 7 } }).issues[0]?.path).toEqual(["header", "center"]);
    expect(reject({ body: [], page: { size: "A9" } }).issues[0]?.path).toEqual(["page", "size"]);
  });
});

/**
 * The runtime half of the schema/union lockstep (the compile-time half is
 * `DocumentNodeSchemaMatchesUnion`). `DOCUMENT_NODE_KINDS` and the schema's discriminated-union
 * options are written independently, so this is what catches a kind added to one and not the other.
 */
describe("node-kind lockstep", () => {
  it("the schema validates exactly the 11 known node kinds", () => {
    expect(documentNodeKinds()).toEqual([...DOCUMENT_NODE_KINDS]);
    expect(DOCUMENT_NODE_KINDS).toHaveLength(11);
  });

  it("accepts every known kind and only those", () => {
    for (const kind of DOCUMENT_NODE_KINDS) expect(isDocumentNodeKind(kind)).toBe(true);
    expect(isDocumentNodeKind("footnote")).toBe(false);
    expect(isDocumentNodeKind(undefined)).toBe(false);
  });
});
