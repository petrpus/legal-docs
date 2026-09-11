/**
 * The edited Snapshot — an edited document is a first-class Snapshot (ADR-0014).
 *
 * A human edits an assembled document by producing an Edit set; applying it to the base Snapshot's
 * frozen tree yields another Snapshot, with its own id, that re-renders through the unchanged
 * `renderFromSnapshot`. The audit chain is closed by {@link verifyEditedSnapshot}: given the base and
 * the edited record, anyone can re-derive the document and confirm nothing was smuggled in between.
 *
 * Server-side by nature — the id is a `node:crypto` digest (ADR-0012), so this module is deliberately
 * NOT part of the browser-safe `src/core/edit/` barrel, whose `applyEdits` it builds on.
 */

import type { DocumentTree } from "./document-tree";
import { applyEdits } from "./edit/apply";
import { assertValidEditSet, type EditSet } from "./edit/edit-set";
import {
  assertValidSnapshot,
  computeSnapshotId,
  SnapshotError,
  SNAPSHOT_SCHEMA_VERSION,
  type Snapshot,
} from "./snapshot";

/**
 * A {@link Snapshot} known to be edited: it always carries the derived `tree` and the `derivedFrom`
 * Edit set that produced it, so a caller need not re-check either. Structurally still a `Snapshot` —
 * this is a narrowing, not a second type.
 */
export type EditedSnapshot = Snapshot & { tree: DocumentTree; derivedFrom: EditSet };

/**
 * Derive an edited {@link Snapshot} from a tree-bearing base Snapshot and an {@link EditSet}.
 *
 * The result is a `tree`-mode Snapshot: the tree is no longer the assembly of the frozen inputs, so it
 * is the only reproducible artifact — but the base's provenance (payload, resolved payload, Clause
 * pins) travels with it so the edited document still says which generation it came from. `derivedFrom`
 * carries the Edit set verbatim, which is what makes the derivation re-playable.
 *
 * Throws a {@link SnapshotError} for a base that cannot be edited (no tree, `pins` mode) or an Edit set
 * addressing a different Snapshot, an `EditSetValidationError` for a malformed Edit set, and an
 * `EditError` naming the op index and path for an op that cannot be applied. The base object — and its
 * tree — are never mutated.
 */
export function buildEditedSnapshot(base: Snapshot, edits: EditSet): EditedSnapshot {
  assertValidSnapshot(base);
  if (base.mode === "pins" || base.tree === undefined) {
    throw new SnapshotError(
      `buildEditedSnapshot: a ${base.mode}-mode Snapshot freezes no tree to edit — re-render it to a tree-bearing Snapshot first`,
    );
  }
  assertValidEditSet(edits);
  if (edits.baseSnapshotId !== base.id) {
    throw new SnapshotError(
      `buildEditedSnapshot: the Edit set addresses Snapshot "${edits.baseSnapshotId}", but the base Snapshot is "${base.id}"`,
    );
  }
  // `applyEdits` is pure: it validates, deep-copies and applies on the copy, so a rejected op leaves
  // the base tree untouched and no partially-edited tree can escape.
  const tree = applyEdits(base.tree, edits.ops);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    id: computeSnapshotId({
      template: base.template,
      version: base.version,
      ...(base.variant !== undefined ? { variant: base.variant } : {}),
      locale: base.locale,
      payload: base.payload,
      tree,
      derivedFromSnapshotId: base.id,
    }),
    mode: "tree",
    template: base.template,
    version: base.version,
    ...(base.variant !== undefined ? { variant: base.variant } : {}),
    locale: base.locale,
    ...(base.payload !== undefined ? { payload: base.payload } : {}),
    ...(base.resolved !== undefined ? { resolved: base.resolved } : {}),
    ...(base.pins !== undefined ? { pins: base.pins } : {}),
    tree,
    derivedFrom: edits,
  };
}

/** Why a claimed derivation does not hold. A caller discriminates on this rather than on the message. */
export type EditedSnapshotIssue =
  /** The snapshot claims no derivation — it carries no `derivedFrom`. */
  | "not-derived"
  /** The Edit set addresses a different base Snapshot than the one supplied. */
  | "base-mismatch"
  /** The Edit set no longer applies to the base (a tampered op, or a tampered base tree). */
  | "not-applicable"
  /** Re-applying reproduces a different document than the one recorded. */
  | "tree-mismatch"
  /** The recorded id is not the digest of the re-derived document. */
  | "id-mismatch"
  /** Template/version/variant/locale or the inherited provenance does not match the base. */
  | "metadata-mismatch";

export type EditedSnapshotVerification = { ok: true } | { ok: false; issue: EditedSnapshotIssue; message: string };

/**
 * Re-derive an edited Snapshot from its base and check that the record matches — the audit answer to
 * "is this really what that generation plus that Edit set produce?". Never throws: a tampered or
 * unusable input is reported as a typed failure, because that IS the answer being asked for.
 */
export function verifyEditedSnapshot(base: Snapshot, edited: Snapshot): EditedSnapshotVerification {
  if (edited.derivedFrom === undefined) {
    return fail("not-derived", `Snapshot "${edited.id}" carries no derivedFrom Edit set — it is not an edited Snapshot`);
  }
  if (edited.derivedFrom.baseSnapshotId !== base.id) {
    return fail(
      "base-mismatch",
      `The Edit set was recorded against Snapshot "${edited.derivedFrom.baseSnapshotId}", not against the supplied base "${base.id}"`,
    );
  }
  let rebuilt: EditedSnapshot;
  try {
    rebuilt = buildEditedSnapshot(base, edited.derivedFrom);
  } catch (error) {
    return fail("not-applicable", `The Edit set cannot be re-applied to the base: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!deepEqual(rebuilt.tree, edited.tree)) {
    return fail("tree-mismatch", `Re-applying the Edit set to "${base.id}" produces a different document than Snapshot "${edited.id}" records`);
  }
  if (rebuilt.id !== edited.id) {
    return fail("id-mismatch", `The re-derived document hashes to "${rebuilt.id}", but the Snapshot records id "${edited.id}"`);
  }
  // Everything else the record carries is inherited from the base verbatim, so any difference means
  // the record was edited outside the Edit set — including fields the digest cannot see.
  const differing = differingKeys(rebuilt, edited);
  if (differing.length > 0) {
    return fail("metadata-mismatch", `Snapshot "${edited.id}" does not inherit the base's ${differing.join(", ")}`);
  }
  return { ok: true };
}

function fail(issue: EditedSnapshotIssue, message: string): EditedSnapshotVerification {
  return { ok: false, issue, message };
}

/** The keys where two records differ, ignoring the ones already compared with a better message. */
function differingKeys(expected: Snapshot, actual: Snapshot): string[] {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  keys.delete("tree");
  keys.delete("id");
  const record = (snapshot: Snapshot) => snapshot as unknown as Record<string, unknown>;
  return [...keys].filter((key) => !deepEqual(record(expected)[key], record(actual)[key])).sort();
}

/** Structural equality over the JSON values a Snapshot is made of (key order is irrelevant). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}
