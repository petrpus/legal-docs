import { z, type ZodType } from "zod";
import { LegalDocsError } from "./errors";
import type { PayloadSchemaRegistry } from "./payload";

/**
 * JSON Schema draft to emit. Defaults to `draft-7` — the broadest-supported dialect across form
 * generators and validators (AJV, react-jsonschema-form). `2020-12` is zod's native, modern output.
 */
export type JsonSchemaTarget = "draft-7" | "draft-2020-12";

export interface JsonSchemaOptions {
  /** JSON Schema dialect to target. Defaults to `draft-7`. */
  target?: JsonSchemaTarget;
}

/** A plain, serializable JSON Schema document (the shape `z.toJSONSchema` returns). */
export type JsonSchema = Record<string, unknown>;

/**
 * Convert a single payload zod schema to a JSON Schema document, so an external tool (a form builder,
 * a validator, an API gateway) can consume a Template's payload contract without depending on zod.
 * A schema zod cannot represent (e.g. one with a transform) is wrapped in a `LegalDocsError`.
 */
export function exportPayloadSchema(schema: ZodType, options: JsonSchemaOptions = {}): JsonSchema {
  try {
    return z.toJSONSchema(schema, { target: options.target ?? "draft-7" }) as JsonSchema;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new LegalDocsError(`Cannot export schema to JSON Schema: ${reason}`, { cause });
  }
}

/**
 * Convert a whole {@link PayloadSchemaRegistry} to JSON Schema, keyed by the same schema names the
 * Templates reference via `payloadSchema`. The offending key is named if any schema fails to convert.
 */
export function exportPayloadSchemas(
  registry: PayloadSchemaRegistry,
  options: JsonSchemaOptions = {},
): Record<string, JsonSchema> {
  const target = options.target ?? "draft-7";
  const out: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(registry)) {
    // Call `z.toJSONSchema` directly (not `exportPayloadSchema`) so failures wrap exactly once, with
    // the registry key — routing through the single-schema helper would double the message and cause.
    try {
      out[name] = z.toJSONSchema(schema, { target }) as JsonSchema;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new LegalDocsError(`Cannot export schema "${name}" to JSON Schema: ${reason}`, { cause });
    }
  }
  return out;
}
