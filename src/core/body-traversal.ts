/**
 * Body traversal — the single module that owns the closed Body-item union (docs/CONTEXT.md: *Body
 * item*, *Body traversal*). Every Body item falls into exactly one class:
 *
 * - **leaf** — carries no nested authored body (inline text, a Clause reference, a Block reference,
 *   `custom`),
 * - **nested** — carries its own body/bodies (`article`, the lists),
 * - **control** — `if` / `for`; carries branches whose expansion is decided at assembly time,
 * - **directive** — `include` / `slot`; an authoring indirection spliced away before assembly
 *   (Include expansion / Slot filling), never reaching tree assembly.
 *
 * Tree assembly, Include expansion, Slot filling and the Catalog integrity lint all walk bodies
 * through this module and contribute only their own behaviour, never the enumeration. TS
 * exhaustiveness for Body items is enforced here, once, via the `never` check in {@link classify}.
 */

import { LegalDocsError } from "./errors";
import type { BodyItem } from "./template";

export type TitleItem = Extract<BodyItem, { title: unknown }>;
export type ParagraphItem = Extract<BodyItem, { paragraph: unknown }>;
export type ClauseItem = Extract<BodyItem, { clause: unknown }>;
export type PartyHeaderItem = Extract<BodyItem, { partyHeader: unknown }>;
export type KeyValueTableItem = Extract<BodyItem, { keyValueTable: unknown }>;
export type SignaturesItem = Extract<BodyItem, { signatures: unknown }>;
export type CustomItem = Extract<BodyItem, { custom: unknown }>;
export type ArticleBodyItem = Extract<BodyItem, { article: unknown }>;
export type NumberedListItem = Extract<BodyItem, { numberedList: unknown }>;
export type BulletListItem = Extract<BodyItem, { bulletList: unknown }>;
export type AlphaListItem = Extract<BodyItem, { alphaList: unknown }>;
export type IfItem = Extract<BodyItem, { if: unknown }>;
export type ForItem = Extract<BodyItem, { for: unknown }>;
export type IncludeItem = Extract<BodyItem, { include: unknown }>;
export type SlotItem = Extract<BodyItem, { slot: unknown }>;

/**
 * One named sub-body of a nested/control item. `label` is the path suffix appended to the item's own
 * path — the shared vocabulary already used by Include expansion and the integrity lint
 * (` › article`, `[0]`, ` › then`, ` › else`, ` › for`).
 */
export interface SubBody {
  label: string;
  body: BodyItem[];
}

/** Rebuild the item around transformed sub-bodies, given in {@link SubBody} order. */
export type Rebuild = (bodies: BodyItem[][]) => BodyItem;

export type ClassifiedBodyItem =
  | { class: "leaf"; kind: "title"; item: TitleItem }
  | { class: "leaf"; kind: "paragraph"; item: ParagraphItem }
  | { class: "leaf"; kind: "clause"; item: ClauseItem }
  | { class: "leaf"; kind: "partyHeader"; item: PartyHeaderItem }
  | { class: "leaf"; kind: "keyValueTable"; item: KeyValueTableItem }
  | { class: "leaf"; kind: "signatures"; item: SignaturesItem }
  | { class: "leaf"; kind: "custom"; item: CustomItem }
  | { class: "nested"; kind: "article"; item: ArticleBodyItem; subBodies: SubBody[]; rebuild: Rebuild }
  | { class: "nested"; kind: "numberedList"; item: NumberedListItem; subBodies: SubBody[]; rebuild: Rebuild }
  | { class: "nested"; kind: "bulletList"; item: BulletListItem; subBodies: SubBody[]; rebuild: Rebuild }
  | { class: "nested"; kind: "alphaList"; item: AlphaListItem; subBodies: SubBody[]; rebuild: Rebuild }
  | { class: "control"; kind: "if"; item: IfItem; subBodies: SubBody[]; rebuild: Rebuild }
  | { class: "control"; kind: "for"; item: ForItem; subBodies: SubBody[]; rebuild: Rebuild }
  | { class: "directive"; kind: "include"; item: IncludeItem }
  | { class: "directive"; kind: "slot"; item: SlotItem };

/** List groups as indexed sub-bodies (the lint/include `path[i]` vocabulary). */
function groups(bodies: BodyItem[][]): SubBody[] {
  return bodies.map((body, i) => ({ label: `[${i}]`, body }));
}

/**
 * Classify a Body item. This is the one place the closed union is enumerated: a new BodyItem variant
 * fails compilation here (and nowhere else) until classified.
 */
export function classify(item: BodyItem): ClassifiedBodyItem {
  if ("title" in item) return { class: "leaf", kind: "title", item };
  if ("paragraph" in item) return { class: "leaf", kind: "paragraph", item };
  if ("clause" in item) return { class: "leaf", kind: "clause", item };
  if ("partyHeader" in item) return { class: "leaf", kind: "partyHeader", item };
  if ("keyValueTable" in item) return { class: "leaf", kind: "keyValueTable", item };
  if ("signatures" in item) return { class: "leaf", kind: "signatures", item };
  if ("custom" in item) return { class: "leaf", kind: "custom", item };
  if ("article" in item) {
    return {
      class: "nested",
      kind: "article",
      item,
      subBodies: [{ label: " › article", body: item.article.body }],
      rebuild: ([body = []]) => ({ ...item, article: { ...item.article, body } }),
    };
  }
  if ("numberedList" in item) {
    return {
      class: "nested",
      kind: "numberedList",
      item,
      subBodies: groups(item.numberedList),
      rebuild: (bodies) => ({ ...item, numberedList: bodies }),
    };
  }
  if ("bulletList" in item) {
    return {
      class: "nested",
      kind: "bulletList",
      item,
      subBodies: groups(item.bulletList),
      rebuild: (bodies) => ({ ...item, bulletList: bodies }),
    };
  }
  if ("alphaList" in item) {
    return {
      class: "nested",
      kind: "alphaList",
      item,
      subBodies: groups(item.alphaList),
      rebuild: (bodies) => ({ ...item, alphaList: bodies }),
    };
  }
  if ("if" in item) {
    const subBodies: SubBody[] = [{ label: " › then", body: item.then }];
    if (item.else !== undefined) subBodies.push({ label: " › else", body: item.else });
    return {
      class: "control",
      kind: "if",
      item,
      subBodies,
      rebuild: ([then = [], els]) =>
        item.else === undefined ? { ...item, then } : { ...item, then, else: els ?? [] },
    };
  }
  if ("for" in item) {
    return {
      class: "control",
      kind: "for",
      item,
      subBodies: [{ label: " › for", body: item.body }],
      rebuild: ([body = []]) => ({ ...item, body }),
    };
  }
  if ("include" in item) return { class: "directive", kind: "include", item };
  if ("slot" in item) return { class: "directive", kind: "slot", item };
  const unhandled: never = item;
  // Authored YAML is cast, not zod-validated, so a malformed item can still arrive at runtime.
  throw new LegalDocsError(`Unsupported body item: ${JSON.stringify(unhandled)}`);
}

/**
 * Pre-order structural transform of a body. `fn` is called on every item with its path; returning an
 * array splices it in place of the item (one → many, or none) and returning `undefined` keeps the
 * item, recursing into any sub-bodies it carries. A returned replacement is final — it is not
 * re-walked (both Slot fills and expanded Include bodies arrive already fully processed).
 */
export function mapBody(
  items: BodyItem[],
  fn: (item: BodyItem, path: string) => BodyItem[] | undefined,
  path = "body",
): BodyItem[] {
  const out: BodyItem[] = [];
  for (const [i, item] of items.entries()) {
    const at = `${path}[${i}]`;
    const replaced = fn(item, at);
    if (replaced !== undefined) {
      out.push(...replaced);
      continue;
    }
    const classified = classify(item);
    if (classified.class !== "nested" && classified.class !== "control") {
      out.push(item);
      continue;
    }
    out.push(classified.rebuild(classified.subBodies.map((sub) => mapBody(sub.body, fn, at + sub.label))));
  }
  return out;
}

/** {@link mapBody} with an async callback; items are processed sequentially, in body order. */
export async function mapBodyAsync(
  items: BodyItem[],
  fn: (item: BodyItem, path: string) => Promise<BodyItem[] | undefined>,
  path = "body",
): Promise<BodyItem[]> {
  const out: BodyItem[] = [];
  for (const [i, item] of items.entries()) {
    const at = `${path}[${i}]`;
    const replaced = await fn(item, at);
    if (replaced !== undefined) {
      out.push(...replaced);
      continue;
    }
    const classified = classify(item);
    if (classified.class !== "nested" && classified.class !== "control") {
      out.push(item);
      continue;
    }
    const bodies: BodyItem[][] = [];
    for (const sub of classified.subBodies) {
      bodies.push(await mapBodyAsync(sub.body, fn, at + sub.label));
    }
    out.push(classified.rebuild(bodies));
  }
  return out;
}

/**
 * Pre-order read-only walk of a body: `visit` is called on every item (including nested/control items
 * themselves) with its path, then the walk descends into any sub-bodies. Sequential — an async
 * visitor is awaited before the walk moves on, so visit order (and e.g. lint-finding order) is
 * deterministic.
 */
export async function walkBody(
  items: BodyItem[],
  visit: (item: BodyItem, path: string) => void | Promise<void>,
  path = "body",
): Promise<void> {
  for (const [i, item] of items.entries()) {
    const at = `${path}[${i}]`;
    await visit(item, at);
    const classified = classify(item);
    if (classified.class !== "nested" && classified.class !== "control") continue;
    for (const sub of classified.subBodies) {
      await walkBody(sub.body, visit, at + sub.label);
    }
  }
}
