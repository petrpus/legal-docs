import type { ZodType } from "zod";

/**
 * Code-side registry mapping a Template's `payloadSchema` reference to its versioned zod schema.
 * Schemas are code (not Catalog content); the consumer supplies them to `renderDocument`.
 */
export type PayloadSchemaRegistry = Record<string, ZodType>;

export interface PayloadIssue {
  path: PropertyKey[];
  message: string;
}

export class PayloadValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly PayloadIssue[],
  ) {
    super(message);
    this.name = "PayloadValidationError";
  }
}

/**
 * Validate a payload against its schema, returning the typed data or throwing a path-precise error
 * naming the first offending field.
 */
export function validatePayload<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const issues: PayloadIssue[] = result.error.issues.map((issue) => ({
    path: [...issue.path],
    message: issue.message,
  }));
  const first = issues[0];
  const where = first && first.path.length > 0 ? first.path.join(".") : "(root)";
  throw new PayloadValidationError(`${where}: ${first?.message ?? "invalid payload"}`, issues);
}
