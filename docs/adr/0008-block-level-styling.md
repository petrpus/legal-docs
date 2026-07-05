# Block-level styling: alignment & indentation as Theme defaults + per-block overrides

Until now every `title`/`paragraph` rendered with a single, document-wide look: the `Theme` fixed the
font size and spacing, and there was no way to centre a heading, right-align a date line, justify body
prose, or indent a paragraph's first line. This ADR adds the first **block-level style properties**
— text **alignment** and **indentation** — and fixes *how* they are expressed. The shape it chooses
(a per-block override that composes over a Theme default) is meant to be the **reusable pattern** for
any future per-block style property (per-block colour, font, keep-with-next, …), so the contract is
recorded here rather than reinvented ad hoc.

## Decision

**Two capabilities, on `title` and `paragraph` only (v1).**
- **Alignment** — `"left" | "center" | "right" | "justify"`.
- **Indentation** — **first-line** indent *and* **block left** indent, both in design points (pt),
  the same unit as every other numeric Theme token.

Other nodes (`article`, lists, `keyValueTable`, `signatures`, `partyHeader`, custom blocks) keep their
own layout and are **out of scope** — they already own their alignment/indent semantics. Because a
`clause` renders its body as `paragraph` nodes, clauses inherit the paragraph defaults for free.

**Both a Theme default and a per-block override, composing "override ?? default".** This is the
headline decision and the pattern to reuse:
- The **Theme** carries the defaults every block of that kind gets:
  ```ts
  align:  { title: Align; paragraph: Align };   // both default "left"
  indent: { firstLine: number; block: number }; // paragraph defaults, both default 0 (pt)
  ```
- An **authoring override** on a specific block wins over the default. The effective value a renderer
  uses is `node.<prop> ?? theme default for that kind` (titles have no first-line/block default — they
  align by Theme but indent only when a block asks).

**Authoring gains a string-or-object form for `title`/`paragraph`.** The string shorthand stays the
common case; an object form adds the optional style props (this introduces a new authoring pattern —
prior optional config used `key: string + siblingField?`, e.g. `clause + vars`; block styling instead
uses a value union so the styled and bare forms read naturally):
```yaml
- title: "PLEDGE AGREEMENT"                                  # shorthand — unchanged
- title:     { text: "PLEDGE AGREEMENT", align: center }
- paragraph: { text: "{{ $recital }}", align: justify, indent: 24, firstLineIndent: 18 }
```
The `text` still flows through `{{ }}` interpolation; `align`/`indent`/`firstLineIndent` are **static**
(not expression-evaluated) in v1. The Zod schema for each becomes `z.union([z.string, z.object({…})])`
and the engine normalizes both forms to the same node.

**The `DocumentNode` carries the resolved override, not the Theme default.** `title`/`paragraph` nodes
gain optional `align?` and `indent?: { firstLine?: number; left?: number }`. The engine sets them only
from the authored override; the **renderer** applies the Theme default when the node omits them. So the
tree stays theme-independent (a snapshot re-renders under a different Theme and the defaults follow the
new Theme), and per-block intent is preserved.

**Each renderer maps to its native mechanism** (same "one Theme, three interpretations" principle as
existing tokens):
- **PDF** (react-pdf `Text`): `textAlign`; block indent → `marginLeft` (pt); first-line indent →
  `textIndent` where supported, otherwise a documented approximation.
- **HTML**: Theme defaults live in the class CSS (`.title`, `.legal-doc p` gain `text-align` /
  `text-indent` / `margin-left`); a per-block override emits an **inline `style`** on that element,
  which overrides the class rule.
- **DOCX** (`docx` `Paragraph`): `alignment: AlignmentType.*`; `indent: { left, firstLine }` in
  **twips** (pt ×20, via the existing `twips()` helper). `AlignmentType` is newly imported.

## Consequences

- The authoring surface for `title`/`paragraph` is now a union (string | object); the string form is
  unchanged, so existing templates keep parsing. AUTHORING.md and THEMING.md document the object form
  and the new tokens.
- `Theme` grows an `align` group and an `indent` group; `defaultTheme` keeps today's look (all `left`,
  zero indent), so existing golden output is unchanged.
- `DocumentNode` `title`/`paragraph` gain two optional fields; the snapshot format is a superset
  (older snapshots without the fields still render — the renderer falls back to the Theme default).
- The "override ?? Theme default", node-carries-override-only shape is the template for future
  per-block style props; adding one later means: a node field, a schema/engine arm, and one line per
  renderer — no new architecture.

## Alternatives (revisit if this proves limiting)

- **Theme-only (no per-block override).** Simplest, but can't centre *one* heading or justify *one*
  recital — too coarse for real legal documents. Rejected.
- **Per-block-only (no Theme default).** Every block would have to restate alignment/indent; verbose
  and unthemeable. Rejected.
- **Expression-valued align/indent** (`align: "{{ … }}"`). Deferred — static covers the cases; can be
  layered on later without changing the node/renderer contract.
- **Negative indent (hanging indent / outdent).** Deferred — v1 rejects negative `indent`/
  `firstLineIndent` at assembly so the three renderers stay consistent (DOCX would need `w:ind` sign
  handling that PDF/HTML express differently). Revisit when a document needs a hanging indent.
- **Extend to all nodes now** (lists, tables, signatures). Deferred — those own richer layout; widening
  the contract to them is a separate, larger decision.
