/**
 * A Clause declares a small, declarative mini-schema for its own `vars` (authored in YAML, so not
 * zod code). This compiles/validates that descriptor — the template maps a payload slice into the
 * vars, and these are checked against it before the clause text is interpolated.
 */
export type VarType = "string" | "integer" | "number" | "boolean";

export interface VarSpec {
  type: VarType;
  min?: number;
  max?: number;
  optional?: boolean;
}

export type VarsSchema = Record<string, VarSpec>;

export class VarsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VarsValidationError";
  }
}

/** Validate bound vars against a Clause's mini-schema, returning the accepted subset. */
export function validateVars(
  schema: VarsSchema,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema)) {
    const value = values[name];
    if (value === undefined || value === null) {
      if (spec.optional) continue;
      throw new VarsValidationError(`${name}: required`);
    }
    checkValue(name, spec, value);
    out[name] = value;
  }
  return out;
}

function checkValue(name: string, spec: VarSpec, value: unknown): void {
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") throw typeError(name, "string", value);
      break;
    case "boolean":
      if (typeof value !== "boolean") throw typeError(name, "boolean", value);
      break;
    case "number":
    case "integer": {
      if (typeof value !== "number") throw typeError(name, spec.type, value);
      if (spec.type === "integer" && !Number.isInteger(value)) {
        throw new VarsValidationError(`${name}: expected an integer, got ${value}`);
      }
      if (spec.min !== undefined && value < spec.min) {
        throw new VarsValidationError(`${name}: must be >= ${spec.min}`);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw new VarsValidationError(`${name}: must be <= ${spec.max}`);
      }
      break;
    }
    default: {
      // The descriptor comes from untrusted YAML, so an unknown `type` must fail loudly rather than
      // silently skip validation.
      const unknownType: string = spec.type;
      throw new VarsValidationError(`${name}: unknown var type "${unknownType}"`);
    }
  }
}

function typeError(name: string, type: string, value: unknown): VarsValidationError {
  return new VarsValidationError(`${name}: expected a ${type}, got ${typeof value}`);
}
