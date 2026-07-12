import { LegalDocsError } from "./errors";
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

/**
 * The snapshot format version. A {@link Snapshot} is a long-lived, persisted audit artifact, so its
 * shape is versioned: {@link renderFromSnapshot} rejects a snapshot whose `schemaVersion` it doesn't
 * understand instead of failing obscurely deep inside a renderer. Bump this on any breaking shape change.
 *
 * v2: `tree` changed from a bare `DocumentNode[]` to a `DocumentTree` object (`{ body, header?,
 * footer?, page? }`) so page furniture — and later the page setup (ADR-0013), an additive optional
 * field, no bump — is frozen for re-render (ADR-0011). v1 snapshots (array `tree`) are rejected.
 */
export const SNAPSHOT_SCHEMA_VERSION = 2;

/** Thrown when a value handed to `renderFromSnapshot` is not a valid/known-version Snapshot. */
export class SnapshotError extends LegalDocsError {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/** A concrete Clause version resolved during assembly — the audit pin for `@latest`/`@vN` refs. */
export interface ClausePin {
  /** The reference as authored (`pledge-security@v1`, `aml.intro@latest`, …). */
  ref: string;
  /** The concrete Clause id it resolved to. */
  clause: string;
  /** The concrete version frozen. */
  version: number;
  /** The locale the assembly requested (the document's resolved locale). */
  locale: string;
  /**
   * The locale of the Clause file that actually loaded — equal to `locale` unless the store fell back.
   * Pinned so a `pins`-mode re-render loads the exact file, not a re-run of the (order-dependent) fallback.
   */
  resolvedLocale?: string;
}

/**
 * The immutable, JSON-serializable record a generation produces for audit and deterministic
 * re-render. Which fields are present depends on {@link SnapshotMode}; `id`, `mode`, `template`,
 * `version` and `locale` are always present.
 */
export interface Snapshot {
  /** Format version of this snapshot's shape (see {@link SNAPSHOT_SCHEMA_VERSION}). */
  schemaVersion: number;
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
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
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

/**
 * Guard a value about to be re-rendered as a {@link Snapshot}: reject a non-object, an unknown
 * `schemaVersion`, or a snapshot missing its always-present fields — with a clear {@link SnapshotError}
 * rather than an obscure failure deep in a renderer.
 */
export function assertValidSnapshot(value: unknown): asserts value is Snapshot {
  if (typeof value !== "object" || value === null) {
    throw new SnapshotError("Not a snapshot (expected an object)");
  }
  const s = value as Partial<Snapshot>;
  // v1 has no predecessors, so any other version is definitionally garbage — reject rather than
  // migrate. When a v2 lands this becomes a migration decision (migrate step or an explicit policy).
  if (s.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotError(
      `Unsupported snapshot schemaVersion ${JSON.stringify(s.schemaVersion)} (this build understands ${SNAPSHOT_SCHEMA_VERSION}) — re-generate the snapshot`,
    );
  }
  if (s.mode !== "full" && s.mode !== "tree" && s.mode !== "pins") {
    throw new SnapshotError(`Malformed snapshot: unknown mode ${JSON.stringify(s.mode)}`);
  }
  if (typeof s.template !== "string" || typeof s.version !== "number" || typeof s.locale !== "string") {
    throw new SnapshotError("Malformed snapshot: missing one of template/version/locale");
  }
  // Tree-bearing modes must carry a DocumentTree whose `body` is an array, else the renderer fails deep
  // (the very thing this guard exists to prevent). A v1 array-`tree` snapshot fails here after the
  // schemaVersion check already rejected it.
  if (s.mode === "full" || s.mode === "tree") {
    const tree = s.tree as { body?: unknown } | undefined;
    if (typeof tree !== "object" || tree === null || !Array.isArray(tree.body)) {
      throw new SnapshotError(`Malformed snapshot: ${s.mode}-mode snapshot has no tree body array`);
    }
  }
}

function snapshotId(gen: SnapshotInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        template: gen.template,
        version: gen.version,
        variant: gen.variant ?? null,
        locale: gen.locale,
        // Hash the body under the `tree` key (as v1 did) so a document with no furniture keeps its
        // v1 id; header/footer only perturb the id of documents that actually declare them.
        tree: gen.tree.body,
        ...(gen.tree.header !== undefined ? { header: gen.tree.header } : {}),
        ...(gen.tree.footer !== undefined ? { footer: gen.tree.footer } : {}),
        ...(gen.tree.page !== undefined ? { page: gen.tree.page } : {}),
        payload: gen.payload ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}
