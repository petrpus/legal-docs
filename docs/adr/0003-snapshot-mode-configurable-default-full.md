# Snapshot is configurable; default `full` freezes tree + inputs

A generated document must be re-renderable identically for audit ("exactly what was in this
document"). The question is *what* a Snapshot freezes. Three levels exist: version **pins** only
(robust to catalog changes but not engine changes, and depends on the catalog still holding the
versions); the assembled **DocumentNode tree** only (robust to catalog *and* engine changes,
self-contained); or **both** (tree as the re-render source of truth, plus raw + Resolved payload and
version pins for the audit trail and cross-check).

**Decision:** make it a configurable **Snapshot mode** (engine-level default, overridable per
`renderDocument` call) with three values — `full`, `tree`, `pins` — defaulting to **`full`** (tree +
inputs). For legal documents, deterministic re-render is a hard requirement, so the default is the
strongest, self-contained option; consumers who do not need engine-change-proof re-render can trade
down to `tree` or `pins` for smaller snapshots.

The Snapshot never freezes the rendered output bytes: re-render still depends on renderer stability,
which is covered by renderer versioning and parity/snapshot tests. A consumer needing a byte-exact
archive stores the output artifact itself. The library creates the Snapshot and returns it; the
consumer persists and retrieves it (same boundary as the rendered output).

## Consequences

- Re-render logic branches on Snapshot mode: render the frozen tree (`full`/`tree`) vs re-run the
  engine over pins (`pins`).
- `pins` mode is a footgun for audit if the catalog later drops a version; the `full` default avoids
  it. The mode is opt-down, never silently weaker.
- Snapshot size grows with `full`/`tree` (the tree is embedded) — acceptable for legal documents.
