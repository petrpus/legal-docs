import type { BodyItem, Include } from "./template";

/** Loads an Include by id (provided by the Catalog over its CatalogStore). */
export type IncludeLoader = (id: string) => Promise<Include>;

/** A bad `include`: an unknown partial id or an include cycle. Carries the body path of the include. */
export class IncludeError extends Error {
  constructor(
    message: string,
    /** Location of the offending `include`, e.g. `body[2] › greeting-block`. */
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "IncludeError";
  }
}

/**
 * Expand every `{ include: <id> }` body item in place into the referenced Include's body, recursively
 * (an Include may itself include another). Walks nested bodies (`article`, lists, `if`, `for`) too.
 * The result is a concrete body with no `include` items left — what tree assembly consumes.
 * Throws an {@link IncludeError} on an unresolved Include or an include cycle.
 */
export function expandIncludes(
  body: BodyItem[],
  loadInclude: IncludeLoader,
  path = "body",
): Promise<BodyItem[]> {
  return expand(body, loadInclude, [], path);
}

async function expand(
  body: BodyItem[],
  loadInclude: IncludeLoader,
  stack: string[],
  path: string,
): Promise<BodyItem[]> {
  const out: BodyItem[] = [];
  for (const [i, item] of body.entries()) {
    const at = `${path}[${i}]`;
    if ("include" in item) {
      out.push(...(await expandInclude(item.include, loadInclude, stack, at)));
    } else {
      out.push(await expandNested(item, loadInclude, stack, at));
    }
  }
  return out;
}

async function expandInclude(
  id: string,
  loadInclude: IncludeLoader,
  stack: string[],
  at: string,
): Promise<BodyItem[]> {
  if (stack.includes(id)) {
    throw new IncludeError(`include cycle: ${[...stack, id].join(" → ")}`, at);
  }
  let include: Include;
  try {
    include = await loadInclude(id);
  } catch (cause) {
    throw new IncludeError(`include "${id}" does not resolve`, at, { cause });
  }
  return expand(include.body, loadInclude, [...stack, id], `${at} › ${id}`);
}

/** Rebuild an item, expanding includes inside any nested bodies it carries. */
async function expandNested(
  item: BodyItem,
  loadInclude: IncludeLoader,
  stack: string[],
  at: string,
): Promise<BodyItem> {
  if ("article" in item) {
    const body = await expand(item.article.body, loadInclude, stack, `${at} › article`);
    return { ...item, article: { ...item.article, body } };
  }
  if ("numberedList" in item) {
    return { ...item, numberedList: await expandGroups(item.numberedList, loadInclude, stack, at) };
  }
  if ("bulletList" in item) {
    return { ...item, bulletList: await expandGroups(item.bulletList, loadInclude, stack, at) };
  }
  if ("alphaList" in item) {
    return { ...item, alphaList: await expandGroups(item.alphaList, loadInclude, stack, at) };
  }
  if ("if" in item) {
    const then = await expand(item.then, loadInclude, stack, `${at} › then`);
    if (item.else === undefined) return { ...item, then };
    const els = await expand(item.else, loadInclude, stack, `${at} › else`);
    return { ...item, then, else: els };
  }
  if ("for" in item) {
    return { ...item, body: await expand(item.body, loadInclude, stack, `${at} › for`) };
  }
  // Leaf items carry no nested body, so they pass through unchanged. A future BodyItem variant that
  // DOES carry a body must be added above, here and in engine.ts/validate.ts (all hand-enumerate the
  // union) — otherwise includes nested inside it would silently escape expansion.
  return item;
}

function expandGroups(
  groups: BodyItem[][],
  loadInclude: IncludeLoader,
  stack: string[],
  at: string,
): Promise<BodyItem[][]> {
  return Promise.all(groups.map((group, i) => expand(group, loadInclude, stack, `${at}[${i}]`)));
}
