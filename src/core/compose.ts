import { LegalDocsError } from "./errors";
import type { BaseTemplate, BodyItem, Template, Variant } from "./template";
import { mapBody } from "./body-traversal";

/** A bad family composition: a Variant extending the wrong base, or overriding an undeclared Slot. */
export class CompositionError extends LegalDocsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CompositionError";
  }
}

/**
 * Compose a Base template + a Variant into one concrete Template: every `{ slot: name }` in the base
 * body is replaced by the Variant's fill for that Slot (or removed if the Variant does not fill it),
 * and the Variant's identity and party roles are carried onto the result. The base's structure
 * (`if`/`for`, articles, lists) and metadata (schema, derivations) are preserved untouched.
 *
 * Throws a {@link CompositionError} if the Variant extends a different family, or if the Variant
 * overrides a Slot the base never declares. The same Slot name may appear more than once (e.g. in
 * both arms of an `if`); every occurrence receives that Slot's fill.
 */
export function composeTemplate(base: BaseTemplate, variant: Variant): Template {
  if (variant.extends !== base.base) {
    throw new CompositionError(
      `variant "${variant.variant}" extends "${variant.extends}" but the base is "${base.base}"`,
    );
  }
  const fills = variant.overrides ?? {};
  const seen = new Set<string>();
  const body = fillSlots(base.body, fills, seen);
  for (const slot of Object.keys(fills)) {
    if (!seen.has(slot)) {
      throw new CompositionError(
        `variant "${variant.variant}" overrides slot "${slot}", which base "${base.base}" does not declare`,
      );
    }
  }
  return {
    template: base.base,
    version: base.version,
    locale: base.locale,
    ...(base.payloadSchema !== undefined ? { payloadSchema: base.payloadSchema } : {}),
    ...(base.derivations !== undefined ? { derivations: base.derivations } : {}),
    body,
    variant: variant.variant,
    ...(variant.parties !== undefined ? { parties: variant.parties } : {}),
  };
}

/** Replace every `{ slot }` with its fill (empty if unfilled), recording the Slot names declared. */
function fillSlots(
  body: BodyItem[],
  fills: Record<string, BodyItem[]>,
  seen: Set<string>,
): BodyItem[] {
  return mapBody(body, (item) => {
    if (!("slot" in item)) return undefined;
    // A name may recur (e.g. one Slot declared in both `if` arms); each occurrence gets the fill.
    seen.add(item.slot);
    return fills[item.slot] ?? [];
  });
}
