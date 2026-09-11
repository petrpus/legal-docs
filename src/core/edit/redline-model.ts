/**
 * The Redline model — one renderer-agnostic description of "what this edit did to the document".
 *
 * A {@link RedlineDoc} mirrors the *edited* document block by block, with every block labelled by what
 * happened to it and every changed string carrying word-level {@link InlineSegment}s. Deleted blocks are
 * kept in place so the reader sees the document as it was and as it is at once. Both the inline HTML
 * redline and the DOCX tracked-changes export are visitors over this one structure, so the two can
 * never drift into telling different stories about the same edit.
 *
 * Alignment is the shared LCS from `text-diff.ts`: node lists and list items align on structural
 * equality, a changed run is paired positionally, and a pair whose kinds (or whose non-editable
 * identity — an article number, a `custom` block's props) differ degrades to a deletion plus an
 * insertion. A move is therefore a deletion and an insertion too: paths are positional and carry no
 * node identity (ADR-0014).
 *
 * Browser-safe: pure functions over plain data, no dependency (ADR-0012).
 */

import type { Align, BlockIndent, DocumentBody, DocumentNode, DocumentTree, PageFurniture } from "../document-tree";
import { asDocumentTree } from "../document-tree";
import type { RichParagraph, RichRun, RichTextV1 } from "../rich-text";
import { diffWords, lcsAlign, pairAligned, type InlineOp, type InlineSegment } from "../text-diff";
import type { TreePath } from "./tree-path";

/** A changed field of a block: a string leaf diffed by word, or a whole rich-text value by paragraph. */
export type RedlineField =
  | {
      kind: "text";
      path: TreePath;
      /** `undefined` when the optional leaf was absent on that side. */
      before: string | undefined;
      after: string | undefined;
      segments: InlineSegment[];
    }
  | { kind: "richText"; path: TreePath; before: RichTextV1; after: RichTextV1; paragraphs: RedlineParagraph[] };

/** A changed block attribute (`align`, `indent`) — presentation, so it has no inline segments. */
export interface RedlineAttr {
  path: TreePath;
  before: Align | BlockIndent | undefined;
  after: Align | BlockIndent | undefined;
}

/** A rich-text run with its verdict. Marks come from the after side except on a deletion. */
export interface RedlineRun extends RichRun {
  op: InlineOp;
}

/** One paragraph of a diffed rich-text value. `changed` paragraphs carry a word-level mix of runs. */
export interface RedlineParagraph {
  status: "unchanged" | "inserted" | "deleted" | "changed";
  runs: RedlineRun[];
}

/** The nodes of one list item, and what happened to the item as a whole. */
export interface RedlineListItem {
  status: "unchanged" | "inserted" | "deleted" | "changed";
  /** The item's path — in the edited tree, except for a deleted item, which keeps its base path. */
  path: TreePath;
  blocks: RedlineBlock[];
}

/** What a container block holds: an article's body, or a list's items. */
export type RedlineChildren =
  | { of: "body"; blocks: RedlineBlock[] }
  | { of: "items"; items: RedlineListItem[] };

/**
 * One node of the redline. `path` is the node's path in the *edited* tree — except for a `deleted`
 * block, which keeps its path in the base tree, because that is the only tree it exists in.
 *
 * A block that changed both text and presentation is reported as `textChanged` and carries its `attrs`
 * alongside; `attrsChanged` is the presentation-only case. `unchanged`, `inserted` and `deleted` blocks
 * are whole: a renderer emits the node as it stands and does not look inside.
 */
export type RedlineBlock =
  | { status: "unchanged"; path: TreePath; node: DocumentNode }
  | { status: "inserted"; path: TreePath; node: DocumentNode }
  | { status: "deleted"; path: TreePath; node: DocumentNode }
  | { status: "textChanged"; path: TreePath; node: DocumentNode; fields: RedlineField[]; attrs: RedlineAttr[] }
  | { status: "attrsChanged"; path: TreePath; node: DocumentNode; attrs: RedlineAttr[] }
  | { status: "container"; path: TreePath; node: DocumentNode; fields: RedlineField[]; children: RedlineChildren };

/** How many blocks of each status the redline holds, counted recursively through containers and items. */
export interface RedlineStats {
  unchanged: number;
  inserted: number;
  deleted: number;
  textChanged: number;
  attrsChanged: number;
  container: number;
  /** Everything but `unchanged` and `container` — the headline "n blocks changed". */
  changed: number;
}

/** The whole redline: the edited document's blocks, the furniture changes, and the tally. */
export interface RedlineDoc {
  /** The trees this was computed from, by reference — a renderer needs the edited page setup. */
  base: DocumentTree;
  edited: DocumentTree;
  blocks: RedlineBlock[];
  /** Changed page-header/footer slots only (`/header/right`, `/footer/center`, …). */
  furniture: RedlineField[];
  stats: RedlineStats;
}

const FURNITURE_SLOTS = ["left", "center", "right"] as const;

/**
 * Compare a base document tree with an edited one and describe the difference as a {@link RedlineDoc}.
 * Neither input is mutated or copied — the result holds references into both.
 */
export function buildRedline(base: DocumentTree | DocumentBody, edited: DocumentTree | DocumentBody): RedlineDoc {
  const from = asDocumentTree(base);
  const to = asDocumentTree(edited);
  const blocks = redlineNodeList(from.body, to.body, ["body"]);
  const furniture = [
    ...furnitureFields(from.header, to.header, ["header"]),
    ...furnitureFields(from.footer, to.footer, ["footer"]),
  ];
  return { base: from, edited: to, blocks, furniture, stats: tally(blocks) };
}

function redlineNodeList(before: readonly DocumentNode[], after: readonly DocumentNode[], path: TreePath): RedlineBlock[] {
  return pairAligned(lcsAlign(before, after, structurallyEqual)).flatMap<RedlineBlock>((run) => {
    switch (run.op) {
      case "equal":
        return [{ status: "unchanged", path: [...path, run.afterIndex], node: run.after }];
      case "added":
        return [{ status: "inserted", path: [...path, run.afterIndex], node: run.after }];
      case "removed":
        return [{ status: "deleted", path: [...path, run.beforeIndex], node: run.before }];
      case "replaced":
        return redlineNode(run.before, run.after, [...path, run.afterIndex], [...path, run.beforeIndex]);
    }
  });
}

/**
 * Describe one paired node. Returns two blocks — a deletion and an insertion — whenever the pair cannot
 * be reconciled in place: different kinds, a different article number or level (numbering is the
 * engine's, ADR-0014), a party's `kind`, a different row/place count, or any difference at all inside a
 * `custom` block (opaque, ADR-0005).
 */
function redlineNode(before: DocumentNode, after: DocumentNode, path: TreePath, basePath: TreePath): RedlineBlock[] {
  const wholesale = (): RedlineBlock[] => [
    { status: "deleted", path: basePath, node: before },
    { status: "inserted", path, node: after },
  ];
  switch (after.kind) {
    case "title":
    case "paragraph": {
      // A title that became a paragraph (or the reverse) is a different block, not a restyled one.
      if (before.kind !== "title" && before.kind !== "paragraph") return wholesale();
      if (before.kind !== after.kind) return wholesale();
      const fields = textFields(path, [[["text"], before.text, after.text]]);
      const attrs: RedlineAttr[] = [];
      if (before.align !== after.align) attrs.push({ path: [...path, "align"], before: before.align, after: after.align });
      if (!structurallyEqual(before.indent, after.indent)) {
        attrs.push({ path: [...path, "indent"], before: before.indent, after: after.indent });
      }
      return [leafBlock(path, after, fields, attrs)];
    }
    case "richText": {
      if (before.kind !== "richText") return wholesale();
      const field: RedlineField = {
        kind: "richText",
        path: [...path, "value"],
        before: before.value,
        after: after.value,
        paragraphs: redlineParagraphs(before.value, after.value),
      };
      return [{ status: "textChanged", path, node: after, fields: [field], attrs: [] }];
    }
    case "article": {
      if (before.kind !== "article" || before.no !== after.no || before.level !== after.level) return wholesale();
      return [
        {
          status: "container",
          path,
          node: after,
          fields: textFields(path, [[["heading"], before.heading, after.heading]]),
          children: { of: "body", blocks: redlineNodeList(before.body, after.body, [...path, "body"]) },
        },
      ];
    }
    case "numberedList":
    case "bulletList":
    case "alphaList": {
      if (before.kind !== "numberedList" && before.kind !== "bulletList" && before.kind !== "alphaList") {
        return wholesale();
      }
      // A numbered list that became a bulleted one renumbers everything — a new list, not an edited one.
      if (before.kind !== after.kind) return wholesale();
      return [
        {
          status: "container",
          path,
          node: after,
          fields: [],
          children: { of: "items", items: redlineItems(before.items, after.items, [...path, "items"]) },
        },
      ];
    }
    case "partyHeader": {
      if (before.kind !== "partyHeader" || before.party.kind !== after.party.kind) return wholesale();
      const fields = textFields(path, [
        [["roleLabel"], before.roleLabel, after.roleLabel],
        [["party", "name"], before.party.name, after.party.name],
        [["party", "idNumber"], before.party.idNumber, after.party.idNumber],
        [["party", "address"], before.party.address, after.party.address],
      ]);
      return [leafBlock(path, after, fields, [])];
    }
    case "keyValueTable": {
      if (before.kind !== "keyValueTable" || before.rows.length !== after.rows.length) return wholesale();
      const fields = textFields(
        path,
        after.rows.flatMap((row, index) => {
          const was = before.rows[index];
          return [
            [["rows", index, "label"], was?.label, row.label] as FieldProbe,
            [["rows", index, "value"], was?.value, row.value] as FieldProbe,
          ];
        }),
      );
      return [leafBlock(path, after, fields, [])];
    }
    case "signatures": {
      if (before.kind !== "signatures" || before.places.length !== after.places.length) return wholesale();
      const fields = textFields(
        path,
        after.places.flatMap((place, index) => {
          const was = before.places[index];
          return [
            [["places", index, "name"], was?.name, place.name] as FieldProbe,
            [["places", index, "role"], was?.role, place.role] as FieldProbe,
          ];
        }),
      );
      return [leafBlock(path, after, fields, [])];
    }
    case "custom":
      // A Custom block is code-side and opaque: there is no field-level story to tell about it.
      return wholesale();
  }
}

/** A leaf to probe: its path relative to the node, and its value on each side. */
type FieldProbe = [suffix: TreePath, before: string | undefined, after: string | undefined];

function textFields(path: TreePath, probes: readonly FieldProbe[]): RedlineField[] {
  const fields: RedlineField[] = [];
  for (const [suffix, before, after] of probes) {
    if (before === after) continue;
    fields.push({ kind: "text", path: [...path, ...suffix], before, after, segments: diffWords(before ?? "", after ?? "") });
  }
  return fields;
}

/** Text changes outrank presentation ones: a reworded block reports as `textChanged` and carries both. */
function leafBlock(path: TreePath, node: DocumentNode, fields: RedlineField[], attrs: RedlineAttr[]): RedlineBlock {
  if (fields.length > 0) return { status: "textChanged", path, node, fields, attrs };
  if (attrs.length > 0) return { status: "attrsChanged", path, node, attrs };
  return { status: "unchanged", path, node };
}

function redlineItems(before: readonly DocumentNode[][], after: readonly DocumentNode[][], path: TreePath): RedlineListItem[] {
  return pairAligned(lcsAlign(before, after, structurallyEqual)).map<RedlineListItem>((run) => {
    switch (run.op) {
      case "equal":
        return { status: "unchanged", path: [...path, run.afterIndex], blocks: wholeItem(run.after, [...path, run.afterIndex], "unchanged") };
      case "added":
        return { status: "inserted", path: [...path, run.afterIndex], blocks: wholeItem(run.after, [...path, run.afterIndex], "inserted") };
      case "removed":
        return { status: "deleted", path: [...path, run.beforeIndex], blocks: wholeItem(run.before, [...path, run.beforeIndex], "deleted") };
      case "replaced":
        return {
          status: "changed",
          path: [...path, run.afterIndex],
          blocks: redlineNodeList(run.before, run.after, [...path, run.afterIndex]),
        };
    }
  });
}

/** An item that was added, dropped or left alone is whole — each of its nodes takes the item's verdict. */
function wholeItem(nodes: readonly DocumentNode[], path: TreePath, status: "unchanged" | "inserted" | "deleted"): RedlineBlock[] {
  return nodes.map((node, index) => ({ status, path: [...path, index], node }));
}

/**
 * Diff a rich-text value paragraph by paragraph. Paragraphs align on structural equality — so a
 * mark-only change is a change here, unlike the Clause diff, which compares plain text — and a paired
 * paragraph is diffed by word, taking marks from the after side on equal/inserted runs and from the
 * before side on deleted ones.
 */
function redlineParagraphs(before: RichTextV1, after: RichTextV1): RedlineParagraph[] {
  return pairAligned(lcsAlign(before.blocks, after.blocks, structurallyEqual)).map<RedlineParagraph>((run) => {
    switch (run.op) {
      case "equal":
        return { status: "unchanged", runs: markedRuns(run.after, "equal") };
      case "added":
        return { status: "inserted", runs: markedRuns(run.after, "ins") };
      case "removed":
        return { status: "deleted", runs: markedRuns(run.before, "del") };
      case "replaced":
        return { status: "changed", runs: wordRuns(run.before, run.after) };
    }
  });
}

function markedRuns(paragraph: RichParagraph, op: InlineOp): RedlineRun[] {
  return paragraph.runs.map((run) => ({ ...run, op }));
}

function wordRuns(before: RichParagraph, after: RichParagraph): RedlineRun[] {
  const runs: RedlineRun[] = [];
  let beforeAt = 0;
  let afterAt = 0;
  for (const segment of diffWords(plainText(before), plainText(after))) {
    const length = segment.text.length;
    if (segment.op === "del") {
      runs.push(...sliceRuns(before, beforeAt, beforeAt + length, "del"));
      beforeAt += length;
    } else if (segment.op === "ins") {
      runs.push(...sliceRuns(after, afterAt, afterAt + length, "ins"));
      afterAt += length;
    } else {
      runs.push(...sliceRuns(after, afterAt, afterAt + length, "equal"));
      beforeAt += length;
      afterAt += length;
    }
  }
  return runs;
}

/** The `[from, to)` slice of a paragraph's plain text, re-cut into runs so every mark is preserved. */
function sliceRuns(paragraph: RichParagraph, from: number, to: number, op: InlineOp): RedlineRun[] {
  const out: RedlineRun[] = [];
  let at = 0;
  for (const run of paragraph.runs) {
    const end = at + run.text.length;
    const start = Math.max(at, from);
    const stop = Math.min(end, to);
    if (stop > start) out.push({ ...run, text: run.text.slice(start - at, stop - at), op });
    at = end;
    if (at >= to) break;
  }
  return out;
}

function plainText(paragraph: RichParagraph): string {
  return paragraph.runs.map((run) => run.text).join("");
}

function furnitureFields(before: PageFurniture | undefined, after: PageFurniture | undefined, path: TreePath): RedlineField[] {
  return textFields(
    path,
    FURNITURE_SLOTS.map((slot) => [[slot], before?.[slot], after?.[slot]] as FieldProbe),
  );
}

function tally(blocks: readonly RedlineBlock[]): RedlineStats {
  const stats: RedlineStats = {
    unchanged: 0,
    inserted: 0,
    deleted: 0,
    textChanged: 0,
    attrsChanged: 0,
    container: 0,
    changed: 0,
  };
  const walk = (list: readonly RedlineBlock[]) => {
    for (const block of list) {
      stats[block.status] += 1;
      if (block.status !== "container") continue;
      if (block.children.of === "body") walk(block.children.blocks);
      else for (const item of block.children.items) walk(item.blocks);
    }
  };
  walk(blocks);
  stats.changed = stats.inserted + stats.deleted + stats.textChanged + stats.attrsChanged;
  return stats;
}

/**
 * Structural equality over the JSON a document tree is made of. A key whose value is `undefined` counts
 * as absent, so a tree that went through JSON and one that went through `structuredClone` compare equal
 * (a `custom` block with `props: undefined` is the case that actually occurs).
 */
function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => structurallyEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => structurallyEqual(left[key], right[key]));
}
