import type { BodyItem, Include } from "./template";
import { mapBodyAsync } from "./body-traversal";

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

function expand(
  body: BodyItem[],
  loadInclude: IncludeLoader,
  stack: string[],
  path: string,
): Promise<BodyItem[]> {
  return mapBodyAsync(
    body,
    async (item, at) =>
      "include" in item ? expandInclude(item.include, loadInclude, stack, at) : undefined,
    path,
  );
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

