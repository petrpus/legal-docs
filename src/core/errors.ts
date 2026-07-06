/**
 * The error taxonomy. Every error the library throws extends {@link LegalDocsError}, so a consumer can
 * `catch (e) { if (e instanceof LegalDocsError) … }` for any library failure, and discriminate the
 * common cases (e.g. {@link NotFoundError} → HTTP 404, `PayloadValidationError` → 422) without
 * string-matching messages.
 */
export class LegalDocsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LegalDocsError";
  }
}

/** What kind of thing was not found. */
export type NotFoundKind = "template" | "clause" | "include" | "base" | "variant" | "schema" | "draft" | "pin";

/** A structured locator for a not-found element (only the relevant fields are set). */
export interface NotFoundRef {
  id?: string;
  family?: string;
  variant?: string;
  version?: number;
  locale?: string;
}

/**
 * A referenced catalog element, registration, draft, or snapshot pin could not be found. Carries the
 * {@link NotFoundKind} and a structured {@link NotFoundRef} so callers can map it precisely (e.g. to a
 * 404 with the missing id) rather than parsing the message.
 */
export class NotFoundError extends LegalDocsError {
  readonly kind: NotFoundKind;
  readonly ref: NotFoundRef;
  constructor(kind: NotFoundKind, ref: NotFoundRef = {}, message?: string) {
    super(message ?? defaultMessage(kind, ref));
    this.name = "NotFoundError";
    this.kind = kind;
    this.ref = ref;
  }
}

function defaultMessage(kind: NotFoundKind, ref: NotFoundRef): string {
  const parts: string[] = [];
  if (ref.id !== undefined) parts.push(`"${ref.id}"`); // template/clause/include/schema/draft/pin
  if (ref.variant !== undefined) parts.push(`"${ref.variant}"`); // variant name is the primary id
  if (ref.family !== undefined) parts.push(`(family "${ref.family}")`);
  if (ref.version !== undefined) parts.push(`v${ref.version}`);
  if (ref.locale !== undefined) parts.push(`(${ref.locale})`);
  return [`${kind[0]!.toUpperCase()}${kind.slice(1)}`, ...parts, "not found"].join(" ");
}
