/**
 * `locate` — the single definition of the editable surface.
 *
 * Every Edit op resolves its target through this function, so "what may a human change in a generated
 * document?" is answered in exactly one place instead of drifting between ops. The table it encodes
 * (recorded in ADR-0014):
 *
 * | target                                   | editable as                                    |
 * | ---------------------------------------- | ---------------------------------------------- |
 * | `/body`, `/body/i/body`, `…/items/i`     | node list (insert / remove / move a node)       |
 * | `/body/i`                                | node (replace / remove / move)                  |
 * | title, paragraph `text`                  | required text                                   |
 * | title, paragraph `align`, `indent`        | style                                          |
 * | `richText` `value`                       | the whole RichTextV1 value                      |
 * | article `heading`                        | optional text                                   |
 * | article `no`, `level`                    | NOT editable — numbering is the engine's        |
 * | list `items`                             | list items (insert / remove an item)            |
 * | party `name`; `idNumber`, `address`      | required / optional text (`kind` is frozen)     |
 * | `roleLabel`, kv `label`/`value`, place `name` | required text                              |
 * | signature place `role`                   | optional text                                   |
 * | `custom` `component`, `props`            | NOT editable — opaque (ADR-0005); remove/move only |
 * | `/header`, `/footer`                     | the whole furniture object                      |
 * | `/header/left|center|right` (and footer) | optional text                                   |
 * | `/page`                                  | NOT editable — the template's layout requirement |
 * | a node's `kind`                          | NOT editable — replace the node instead          |
 *
 * The returned location holds LIVE references into the tree it was given; `applyEdits` locates against
 * its own deep copy, never against the caller's tree.
 */

import type {
  Align,
  BlockIndent,
  DocumentNode,
  DocumentTree,
  KeyValueRow,
  PageFurniture,
  PartyIdentification,
  SignaturePlace,
} from "../document-tree";
import { editError, formatTreePath, type TreePath } from "./tree-path";

type StyledNode = Extract<DocumentNode, { kind: "title" | "paragraph" }>;
type RichTextNode = Extract<DocumentNode, { kind: "richText" }>;

/** The furniture slots of a page header or footer. */
const FURNITURE_SLOTS: readonly string[] = ["left", "center", "right"];

/** A string leaf and whether it may be deleted (`setText` with `null`). */
export interface TextLocation {
  kind: "text";
  path: TreePath;
  /** The object holding the leaf — a node, a kv row, a party, a signature place, a furniture object. */
  container: Record<string, unknown>;
  key: string;
  /** `false` when the leaf is optional and may be deleted. */
  required: boolean;
  value: string | undefined;
}

/** What a {@link TreePath} addresses. */
export type TreeLocation =
  | TextLocation
  | { kind: "nodeList"; path: TreePath; list: DocumentNode[] }
  | { kind: "node"; path: TreePath; list: DocumentNode[]; index: number; node: DocumentNode }
  | { kind: "listItems"; path: TreePath; items: DocumentNode[][] }
  | { kind: "richText"; path: TreePath; node: RichTextNode }
  | { kind: "style"; path: TreePath; node: StyledNode; key: "align" | "indent"; value: Align | BlockIndent | undefined }
  | { kind: "furniture"; path: TreePath; tree: DocumentTree; slot: "header" | "footer"; value: PageFurniture | undefined };

/**
 * Resolve a path against a tree. Throws an {@link EditError} naming the path and a reason for anything
 * outside the table above — a frozen field, a key of another node kind, an index outside its list, a
 * segment of the wrong sort, or a path continuing past a leaf.
 */
export function locate(tree: DocumentTree, path: TreePath): TreeLocation {
  if (path.length === 0) throw editError("not-editable", path, "the document root is not an editable target");
  const head = path[0];
  switch (head) {
    case "body":
      return inNodeList(tree.body, path, 1);
    case "header":
    case "footer":
      return inFurniture(tree, head, path);
    case "page":
      throw editError("not-editable", path, "page setup is the template's layout requirement and is not editable");
    default:
      throw unknownKey(path, head, "document tree");
  }
}

function inNodeList(list: DocumentNode[], path: TreePath, at: number): TreeLocation {
  if (at === path.length) return { kind: "nodeList", path, list };
  const index = path[at];
  if (typeof index !== "number") {
    throw editError("invalid-path", path, `expected a node index at ${formatTreePath(path.slice(0, at + 1))}`);
  }
  const node = list[index];
  if (node === undefined) {
    throw editError("out-of-range", path, `node index ${index} is outside a list of ${list.length}`);
  }
  return inNode(node, list, index, path, at + 1);
}

function inNode(node: DocumentNode, list: DocumentNode[], index: number, path: TreePath, at: number): TreeLocation {
  if (at === path.length) return { kind: "node", path, list, index, node };
  const key = path[at];
  if (typeof key !== "string") {
    throw editError("invalid-path", path, `expected a key of the ${node.kind} node at ${formatTreePath(path.slice(0, at + 1))}`);
  }
  if (key === "kind") throw editError("not-editable", path, "a node's kind is not editable — replace the node instead");

  switch (node.kind) {
    case "title":
    case "paragraph":
      if (key === "text") return textLeaf(node, key, true, path, at);
      if (key === "align" || key === "indent") {
        assertLeaf(path, at);
        return { kind: "style", path, node, key, value: node[key] };
      }
      break;
    case "richText":
      if (key === "value") {
        assertLeaf(path, at);
        return { kind: "richText", path, node };
      }
      break;
    case "article":
      if (key === "heading") return textLeaf(node, key, false, path, at);
      if (key === "body") return inNodeList(node.body, path, at + 1);
      if (key === "no" || key === "level") {
        throw editError("not-editable", path, "article numbering is assigned during assembly and is not editable");
      }
      break;
    case "numberedList":
    case "bulletList":
    case "alphaList":
      if (key === "items") return inListItems(node.items, path, at + 1);
      break;
    case "partyHeader":
      if (key === "roleLabel") return textLeaf(node, key, true, path, at);
      if (key === "party") return inParty(node.party, path, at + 1);
      break;
    case "keyValueTable":
      if (key === "rows") return inRowList(node.rows, KEY_VALUE_FIELDS, "a key-value row", path, at + 1);
      break;
    case "signatures":
      if (key === "places") return inRowList(node.places, SIGNATURE_FIELDS, "a signature place", path, at + 1);
      break;
    case "custom":
      if (key === "component" || key === "props") {
        throw editError("not-editable", path, "a custom block is opaque to editing (ADR-0005) — it can only be removed or moved");
      }
      break;
  }
  throw unknownKey(path, key, `${node.kind} node`);
}

function inListItems(items: DocumentNode[][], path: TreePath, at: number): TreeLocation {
  if (at === path.length) return { kind: "listItems", path, items };
  const index = path[at];
  if (typeof index !== "number") {
    throw editError("invalid-path", path, `expected a list-item index at ${formatTreePath(path.slice(0, at + 1))}`);
  }
  const item = items[index];
  if (item === undefined) {
    throw editError("out-of-range", path, `list-item index ${index} is outside a list of ${items.length}`);
  }
  return inNodeList(item, path, at + 1);
}

function inParty(party: PartyIdentification, path: TreePath, at: number): TreeLocation {
  if (at === path.length) {
    throw editError("not-editable", path, "a party is edited field by field (name, idNumber, address)");
  }
  const key = path[at];
  if (typeof key !== "string") {
    throw editError("invalid-path", path, `expected a party field at ${formatTreePath(path.slice(0, at + 1))}`);
  }
  if (key === "kind") throw editError("not-editable", path, "a party's kind is fixed by the generated document");
  const required = PARTY_FIELDS[key];
  if (required === undefined) throw unknownKey(path, key, "party");
  return textLeaf(party, key, required, path, at);
}

/**
 * A list of small records addressed as `…/<key>/<index>/<field>` — key-value rows and signature
 * places. The list and a whole record are reachable but not editable: they are changed cell by cell,
 * or the node is replaced.
 */
function inRowList(
  rows: readonly (KeyValueRow | SignaturePlace)[],
  fields: Record<string, boolean>,
  label: string,
  path: TreePath,
  at: number,
): TreeLocation {
  if (at === path.length) throw editError("not-editable", path, `${label} list is edited cell by cell`);
  const index = path[at];
  if (typeof index !== "number") {
    throw editError("invalid-path", path, `expected an index at ${formatTreePath(path.slice(0, at + 1))}`);
  }
  const row = rows[index];
  if (row === undefined) throw editError("out-of-range", path, `index ${index} is outside a list of ${rows.length}`);
  if (at + 1 === path.length) throw editError("not-editable", path, `${label} is edited field by field`);
  const key = path[at + 1];
  if (typeof key !== "string") {
    throw editError("invalid-path", path, `expected a field name at ${formatTreePath(path.slice(0, at + 2))}`);
  }
  const required = fields[key];
  if (required === undefined) throw unknownKey(path, key, label);
  return textLeaf(row, key, required, path, at + 1);
}

function inFurniture(tree: DocumentTree, slot: "header" | "footer", path: TreePath): TreeLocation {
  const furniture = tree[slot];
  if (path.length === 1) return { kind: "furniture", path, tree, slot, value: furniture };
  const key = path[1];
  if (typeof key !== "string" || !FURNITURE_SLOTS.includes(key)) {
    throw unknownKey(path, key, `${slot} (expected left, center or right)`);
  }
  if (furniture === undefined) throw editError("missing", path, `the document has no ${slot}`);
  return textLeaf(furniture, key, false, path, 1);
}

/** A leaf is the end of a path; anything below it is a malformed address. */
function assertLeaf(path: TreePath, at: number): void {
  if (at + 1 !== path.length) {
    throw editError("invalid-path", path, `${formatTreePath(path.slice(0, at + 1))} is a leaf and has nothing below it`);
  }
}

function textLeaf(container: object, key: string, required: boolean, path: TreePath, at: number): TextLocation {
  assertLeaf(path, at);
  const bag = container as Record<string, unknown>;
  const value = bag[key];
  return { kind: "text", path, container: bag, key, required, value: typeof value === "string" ? value : undefined };
}

const PARTY_FIELDS: Record<string, boolean> = { name: true, idNumber: false, address: false };
const KEY_VALUE_FIELDS: Record<string, boolean> = { label: true, value: true };
const SIGNATURE_FIELDS: Record<string, boolean> = { name: true, role: false };

/**
 * Every key the document model knows, anywhere. A key in this set that is wrong HERE belongs to
 * another node kind (`heading` on a paragraph) — worth telling apart from a key that exists nowhere,
 * because the first is usually a stale path and the second a typo.
 */
const KNOWN_KEYS = new Set([
  "text", "align", "indent", "value", "no", "level", "heading", "body", "items", "party", "roleLabel",
  "rows", "places", "component", "props", "kind", "name", "idNumber", "address", "label", "role",
  "left", "center", "right", "header", "footer", "page", "size", "orientation", "marks", "runs", "blocks", "type",
]);

function unknownKey(path: TreePath, key: unknown, owner: string) {
  const reason = typeof key === "string" && KNOWN_KEYS.has(key) ? "wrong-kind" : "unknown-key";
  return editError(reason, path, `${JSON.stringify(key)} is not an editable key of ${owner.startsWith("a ") || owner.startsWith("the ") ? owner : `a ${owner}`}`);
}
