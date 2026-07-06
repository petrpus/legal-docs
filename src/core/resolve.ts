/**
 * The Resolve phase: run declared Derivations (pure, whitelisted functions over the payload) into
 * the `$derived.*` namespace before tree assembly. All computed/structural inputs live here, so
 * templates only read — `if`/`for` never compute. Derivations are code-side (like helpers/schemas);
 * a Template lists the names it uses, and the consumer supplies the implementations.
 */
import { LegalDocsError } from "./errors";
export type Derivation = (payload: unknown) => unknown;
export type DerivationRegistry = Record<string, Derivation>;

export interface ResolvedPayload {
  derived: Record<string, unknown>;
}

/** Run the named Derivations over the validated payload, producing the `$derived` values. */
export function resolvePayload(
  payload: unknown,
  names: readonly string[],
  registry: DerivationRegistry,
): ResolvedPayload {
  const derived: Record<string, unknown> = {};
  for (const name of names) {
    const derive = registry[name];
    if (!derive) throw new LegalDocsError(`Unknown derivation: ${name}`);
    try {
      derived[name] = derive(payload);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new LegalDocsError(`Derivation "${name}" failed: ${reason}`, { cause });
    }
  }
  return { derived };
}
