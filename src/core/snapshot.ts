import { createHash } from "node:crypto";
import type { DocumentTree } from "./document-tree";

/**
 * What a {@link Snapshot} freezes (ADR-0003). The engine default is `full`; a caller may override it.
 * - `full`: inputs (raw + resolved payload, template@v/variant, clause pins) AND the assembled tree.
 * - `tree`: the assembled tree only (+ minimal metadata).
 * - `pins`: inputs + version pins only, no tree.
 */
export type SnapshotMode = "full" | "tree" | "pins";

/** The default Snapshot mode when a caller does not specify one. */
export const DEFAULT_SNAPSHOT_MODE: SnapshotMode = "full";

/** A concrete Clause version resolved during assembly — the audit pin for `@latest`/`@vN` refs. */
export interface ClausePin {
  /** The reference as authored (`pledge-security@v1`, `aml.intro@latest`, …). */
  ref: string;
  /** The concrete Clause id it resolved to. */
  clause: string;
  /** The concrete version frozen. */
  version: number;
  /** The locale the Clause was resolved for. */
  locale: string;
}

/**
 * The immutable, JSON-serializable record a generation produces for audit and deterministic
 * re-render. Which fields are present depends on {@link SnapshotMode}; `id`, `mode`, `template`,
 * `version` and `locale` are always present.
 */
export interface Snapshot {
  /** Stable digest of the generation (template/version/variant/tree/payload) — mode-independent. */
  id: string;
  mode: SnapshotMode;
  template: string;
  version: number;
  variant?: string;
  locale: string;
  /** Raw input payload (modes `full`, `pins`). */
  payload?: unknown;
  /** Resolved payload — the validated payload enriched with `$derived` (modes `full`, `pins`). */
  resolved?: Record<string, unknown>;
  /** Concrete Clause version pins (modes `full`, `pins`). */
  pins?: ClausePin[];
  /** The assembled DocumentNode tree (modes `full`, `tree`). */
  tree?: DocumentTree;
}

/** Everything a generation can freeze; {@link buildSnapshot} keeps only the mode-relevant parts. */
export interface SnapshotInput {
  template: string;
  version: number;
  variant?: string;
  locale: string;
  /** The raw input payload. Must be JSON-serializable (the consumer's data boundary). */
  payload: unknown;
  /** The resolved payload (`$derived` values). Must be JSON-serializable. */
  resolved: Record<string, unknown>;
  /** Clause pins as recorded during assembly (may contain duplicates / arbitrary order). */
  pins: ClausePin[];
  tree: DocumentTree;
}

/** Build a {@link Snapshot} for the chosen mode. The `id` is computed before any field is dropped. */
export function buildSnapshot(gen: SnapshotInput, mode: SnapshotMode = DEFAULT_SNAPSHOT_MODE): Snapshot {
  const base: Snapshot = {
    id: snapshotId(gen),
    mode,
    template: gen.template,
    version: gen.version,
    locale: gen.locale,
    ...(gen.variant !== undefined ? { variant: gen.variant } : {}),
  };
  // Freeze the distinct, deterministically-ordered pin set so the audit trail is reproducible even
  // though assembly resolves clauses concurrently and re-resolves a looped clause per iteration.
  const inputs = { payload: gen.payload ?? null, resolved: gen.resolved, pins: normalizePins(gen.pins) };
  if (mode === "tree") return { ...base, tree: gen.tree };
  if (mode === "pins") return { ...base, ...inputs };
  return { ...base, ...inputs, tree: gen.tree };
}

function normalizePins(pins: ClausePin[]): ClausePin[] {
  const byKey = new Map<string, ClausePin>();
  for (const pin of pins) byKey.set(`${pin.clause}@${pin.version}|${pin.locale}|${pin.ref}`, pin);
  return [...byKey.values()].sort(
    (a, b) =>
      a.clause.localeCompare(b.clause) ||
      a.version - b.version ||
      a.locale.localeCompare(b.locale) ||
      a.ref.localeCompare(b.ref),
  );
}

function snapshotId(gen: SnapshotInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        template: gen.template,
        version: gen.version,
        variant: gen.variant ?? null,
        locale: gen.locale,
        tree: gen.tree,
        payload: gen.payload ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}
