# Post-generation editing: Edit sets over the tree, and the edited Snapshot

A generated document is frozen the moment it is assembled: a Snapshot pins the template version, the
resolved payload and every Clause version, and `renderFromSnapshot` reproduces it byte for byte
(ADR-0003). Real legal work does not stop there — a lawyer reads the generated draft and changes a
word, strikes a sentence, adds a paragraph the catalog does not have. Until now the only way to do
that was to export DOCX and leave the system, which breaks the audit chain exactly where it matters
most: nobody can say what the signed document differs from, or why.

This ADR fixes how a human edits an assembled document **without leaving the model**.

## Decision

**Ops over the DocumentTree, not over rendered output.** An edit is a typed operation on the
renderer-agnostic tree (`setText`, `setRichText`, `setStyle`, `replaceNode`, `insertNode`,
`removeNode`, `moveNode`, `insertListItem`, `removeListItem`, `setFurniture`), applied by one pure
function, `applyEdits(tree, ops)`. Editing HTML and importing it back — the obvious shortcut, and how
comparable tools do it — was rejected: HTML is one renderer's projection (ADR-0006), so a round trip
through it would silently degrade to whatever that projection can express, and PDF and DOCX would
have to be re-derived from a format that has already lost the structure. Because ops are tree-shaped,
one edit is renderable to all three formats and diffable structurally.

**Structural tree paths, not node ids.** An op addresses its target by a path mirroring the tree's own
JSON shape — `["body", 2, "heading"]`, canonically `/body/2/heading`. Node ids were rejected on two
counts: they would either perturb every persisted Snapshot id or need carving out of the digest, and
they would force an id-assignment pass through the engine plus a type change on every renderer, for a
feature most documents never use. The accepted cost is that a path is only meaningful against one tree
state, so a UI holding a stale path must rebase it — `transformPath` shifts a path through a
structural op, and that rebasing is the editing layer's job, not the caller's.

**Sequential op semantics (RFC 6902 style).** Ops apply in order, each against the tree as the previous
one left it. An insert addresses a *position* rather than an element, so an index equal to the list's
length appends. `moveNode`'s `to` is read against the tree *after* the removal — which is also what
makes a destination inside the moved subtree fail, since that subtree is no longer there to address.
`applyEdits` validates
the input tree, works on a deep copy and validates the result, so it is pure: the caller's tree is
never mutated and a rejected op leaves it exactly as it was — no partial edits. An `EditError` names
the op index, the op kind and the path, so an API can answer "op 3 (`setText`) at `/body/9/props`".

**One editability table, in one function.** `locate` is the single definition of what a human may
change; every op resolves its target through it. Frozen on purpose: article `no`/`level` (numbering is
assigned during assembly — an edited document keeps the numbering it was generated with, because
renumbering would silently rewrite cross-references the payload may carry), `custom` `component` and
`props` (a Custom block is code-side and opaque, ADR-0005 — it can be removed or moved but never
inserted or authored), `page` setup (the template's layout requirement, ADR-0013), a party's `kind`,
and any node's `kind` (replace the node instead).

**The Edit set is the artifact.** `{ schemaVersion, baseSnapshotId, ops, comments?, author?, at?,
note? }` — plain JSON, validated by zod at every boundary it crosses, versioned independently of the
Snapshot. It is called an **Edit set** everywhere: "revision" stays reserved for catalog drafts
(ADR-0009) and "Snapshot" for a generation.

**An edited document is a first-class Snapshot.** `buildEditedSnapshot(base, edits)` applies the ops
to a tree-bearing base and returns a `tree`-mode Snapshot carrying `derivedFrom: EditSet` — a new
**optional, additive** field. `SNAPSHOT_SCHEMA_VERSION` stays **2**: nothing about an existing
snapshot's shape changes, and no existing id moves (pinned by the golden-id test). The edited record
inherits the base's `template`/`version`/`variant`/`locale` and its provenance (`payload`, `resolved`,
`pins`) verbatim, so an edited document still says which generation it came from; its mode is `tree`
because its tree is no longer the assembly of those inputs — the Edit set is the only route back to
it. A `pins`-mode snapshot can neither be a base (no frozen tree to edit) nor carry `derivedFrom`.

**The id mixes in the base Snapshot id — and only that.** The digest gains one key, present only for a
derived snapshot: `derivedFrom: <base id>`. Two consequences are deliberate. A no-op Edit set still
yields a *new* id: "this wording, derived from that generation" is a distinct audit artifact even when
the content came out identical. And two different Edit sets that reach the same wording from the same
base agree on an id, because identity stays a function of content plus lineage. Hashing the ops
themselves was rejected: it would make the id depend on how an editor got there (ten keystrokes versus
one paste), which is a session detail, not a property of the document.

**Verification is a re-derivation, not a signature.** `verifyEditedSnapshot(base, edited)` re-applies
the Edit set to the base and compares the result field by field: a tampered tree, a tampered id, a
swapped base, an Edit set that no longer applies, or rewritten provenance the digest cannot see (the
`pins`, say) each come back as a typed `issue`. It never throws — "is this really what that generation
plus that Edit set produce?" is the question, and a failure is an answer to it.

**Rendering is unchanged.** `renderFromSnapshot` needs no new code path: an edited Snapshot is a
`tree`-mode Snapshot. `renderEdited({ snapshot, edits, format })` is a thin facade that freezes the
edit as a Snapshot *first* and then renders that tree, so an exported document can never exist without
its audit record, and `renderFromSnapshot(result.snapshot)` reproduces the export exactly.

**One redline model, two renderers — and the change list is its flattening.** The difference between a
base tree and an edited one is described once, as a `RedlineDoc` (`src/core/edit/redline-model.ts`):
the edited document mirrored block by block, each block labelled `unchanged` / `inserted` / `deleted` /
`textChanged` / `attrsChanged` / `container`, with every changed string carrying word-level segments and
every changed rich-text value carrying per-paragraph runs. Deleted blocks stay in place so the reader
sees both states at once. The inline HTML redline and the DOCX tracked-changes export are visitors over
this one structure, and `diffTree` — the flat, path-addressed change list an API or an audit log wants —
is literally its flattening, so a change list and a rendered redline can never disagree.

**Alignment is structural, pairing is positional.** Node lists and list items align on a longest common
subsequence over structural equality (`lcsAlign`, generalized out of the Clause paragraph diff so both
share one implementation and `diffRichText`'s output is unchanged); each changed run is then paired
positionally, the k-th removal standing for the k-th addition. An alignment can only say *that* a run
changed, never which old node became which new one, so this is a heuristic — but it is the one that
reads as "this paragraph was reworded" instead of "one vanished and an unrelated one appeared".

**A pair that cannot be reconciled in place degrades to a deletion plus an insertion.** Different kinds
(including a title that became a paragraph, or a numbered list that became bulleted), a different
article `no`/`level`, a different party `kind`, a different key-value row or signature place count, and
*any* difference inside a `custom` block — whose props are opaque (ADR-0005) — are all remove + add.
Because paths carry no node identity, **a move is remove + add too**; this is the cost accepted with
structural paths above, and it is documented rather than worked around. A change is reported at its path
in the **edited** tree, except a removal, which keeps its base-tree path — the only tree it exists in.

**The rendered document addresses itself with `data-path`.** A UI needs to map a click in the preview
back to a place in the tree, and with no node ids (above) the only address is the path. The HTML
Renderer therefore takes an opt-in `emitPaths` option that puts the canonical path string on every
block element — the same string `formatTreePath` produces and `parseTreePath` reads back, so the
editor never invents an addressing scheme of its own. It is **off by default**: an exported document
carries no editing metadata, and the default output stays byte-identical. A `custom` block owns its
markup (ADR-0005/0006), so its HTML is never rewritten to carry the attribute — in `emitPaths` mode it
is wrapped in a plain addressable `<div>` instead, which is enough for the only edits a `custom` node
admits (remove, move). The per-node render step is exported alongside, so the redline and review
Renderers render an untouched block exactly as a plain render does rather than re-implementing the
visitor and drifting from it.

**Editing state is an op log plus a cursor, published as its own subpath.** `createEditSession` keeps
the ops a human authored and an index into them — not a stack of tree states — so undo is "move the
cursor back", the Edit set it exports is exactly "the ops up to the cursor", and resuming a persisted
Edit set is the same code path as replaying one. Every prefix of the log is memoized, which makes
undo/redo allocation-free and gives `session.tree` the property a UI needs: a new reference exactly when
the document changed. History stays **linear** — applying an op after an undo abandons the redo tail
rather than branching — because an Edit set is an ordered list of ops, and a branch has no
representation in it.

The session ships as `@petrpus/legal-docs/edit`, a **separate bundled entry**, not a second entry of the
library build: entries in one build share code-split chunks, and the chunk the root entry pulls in
carries `node:crypto` (Snapshot identity), which would silently make the "browser-safe" subpath
unloadable in a browser. The subpath is also **editor-agnostic**: no ProseMirror, no TipTap, no React
under `src/**`. A WYSIWYG shell binds to the session from outside (the demo does), so a consumer picks
their own editor and the library never carries one. Both rules are enforced by guard tests — a static
scan of the module graph, and a grep of the built bundle's import specifiers.

## Consequences

- The base Snapshot and its output are untouched by editing; base and edited records are both kept, and
  editing an edited Snapshot chains (`derivedFrom.baseSnapshotId` points at the previous link).
- `buildEditedSnapshot` hashes, so it needs `node:crypto` and lives in `src/core/edited-snapshot.ts` —
  outside the browser-safe `src/core/edit/` barrel it builds on. A browser can apply ops and preview;
  identity and the PDF/DOCX exporters stay on the server (ADR-0012).
- The session takes its base Snapshot **structurally** (`{ id, tree? }`), not as an imported `Snapshot`
  type, so the browser-safe subpath does not reach into the module that hashes. A session started from a
  bare tree can edit and preview but cannot export an Edit set until it is given a `baseSnapshotId` —
  an Edit set that names no base is not auditable.
- Numbering, cross-references and the catalog are not re-run after an edit. A document whose articles
  were reordered by hand keeps its generated numbers; if that becomes a real need, it is an explicit
  renumbering op, not a hidden recomputation.
- An Edit set is not an approval workflow. Who may edit, and whether an edit is accepted, is the
  consumer's business — this layer only makes the change auditable.
- Because paths are positional, a stored Edit set is bound to its base tree. Re-basing an Edit set onto
  a *regenerated* document (new payload, new clause versions) is out of scope and would need explicit
  conflict handling.

## Alternatives considered

- **Node ids on `DocumentNode`.** Rejected: cost paid by every document and every renderer, for
  stability only the editing layer needs. See the paths decision above.
- **Editing rendered HTML and importing it back** (how comparable document tools work). Rejected: it
  makes one renderer's projection the source of truth and loses structure the other two formats need.
- **A separate "revision" record next to the Snapshot.** Rejected: it would give the signed document no
  id of its own, so every consumer would have to remember to carry the pair. Making the edited document
  a Snapshot means everything downstream — storage, re-render, diff — already works.
- **Hashing the ops into the id.** Rejected: identity would depend on editing history rather than on
  the document. The Edit set is still stored verbatim in `derivedFrom`, so nothing is lost.
- **Bumping `SNAPSHOT_SCHEMA_VERSION` to 3.** Rejected: an optional additive field is not a breaking
  shape change (the same reasoning as `page` in ADR-0013), and a bump would invalidate every persisted
  snapshot for a feature they do not use.
