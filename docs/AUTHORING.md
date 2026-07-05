# Authoring guide

> How to author templates and clauses for the as-built system. Terminology follows
> [`CONTEXT.md`](./CONTEXT.md); rationale lives in [`adr/`](./adr/).

This guide is for the people who own the **wording** of documents — legal ops, lawyers, anyone who
edits text without touching application code. You write **data files** (YAML/JSON), never code. The
engine validates everything up front, so a mistake fails with a clear message instead of a broken
document.

## The mental model

A document is built from three things:

- A **Template** — the structure of one document type (which sections, in what order).
- **Block**s and **Clause**s it references from the **Catalog** — reusable structure and reusable text.
- A **payload** — the data for one specific document (parties, amounts, dates), supplied by the
  application, not by you.

You author the first two. The application supplies the third. The engine combines them.

> **One rule above all:** templates contain *no logic you compute by hand*. Anything calculated
> (counts, "does this contract have a guarantor?", which clause version to use) is a named
> **Derivation** (see below). Templates only *read* values and *reference* elements.

## Catalog layout

Authored content lives in a folder loaded by `Catalog.fromDir(...)`. Indicative layout:

```
legal-docs/
├── templates/
│   ├── debtor-declaration.yaml
│   └── pledge-agreement/            # a Template family
│       ├── base.yaml
│       ├── two-party.yaml
│       └── three-party.yaml
├── clauses/
│   └── aml.intro/
│       ├── v1.cs.yaml
│       └── v2.cs.yaml               # versioned, locale-tagged
└── includes/
    └── party-block-set.yaml
```

## Writing a Template

A Template is a declarative tree. Its `body` is a list of items; each item references a Block, a
Clause, an Include, inline text, or a control structure.

```yaml
template: debtor-declaration
version: 3
locale: cs
payloadSchema: debtor-declaration        # the versioned zod schema this document expects
body:
  - block: docTitle    text: "DECLARATION AND CONFIRMATION"   # inline literal text
  - block: partyHeader  party: $borrower   roleLabel: "Borrower"
  - clause: declaration.intro@v2           # pinned clause version
  - article:
      no: "1."
      clause: loan.request@latest          # always the newest published version
      vars: { Loan: $loan }
  - for: { each: $warranties, as: w }       # loop over a payload list
      article: { no: "2.{{index+1}}", body: [{ clause: $w }] }
  - if: $borrowerType == "SOLE_TRADER"      # condition — direct field read only
      then:
        - article: { no: "3.", clause: sole.warranties.lead@v1 }
  - signatures: { places: [{ party: $borrower, role: "Borrower" }] }

  # Special-layout document: drop into a renderer-native component
  # - custom: { component: "landscape-grid-note", props: $note }
```

### Styling a title or paragraph (alignment)

`title` and `paragraph` accept either the string shorthand or an object form that adds per-block
style. The object's `text` is still interpolated; the style props are static (ADR-0008):

```yaml
body:
  - title: "PLEDGE AGREEMENT"                              # shorthand — left by default
  - title:     { text: "PLEDGE AGREEMENT", align: center } # centred heading
  - paragraph: { text: "{{ $recital }}", align: justify }  # justified body prose
```

`align` is `left | center | right | justify`. Omit it to inherit the Theme default
(`theme.align.title` / `theme.align.paragraph`); a per-block `align` overrides that default. The same
alignment is applied across PDF, HTML and DOCX.

### Expression syntax

- **Values:** `$path.to.value` (from the payload), `$derived.name` (from the Resolve phase),
  `{{ expr }}` inside text.
- **Conditionals:** `if: … then: … else: …`, inline `{{ flag ? a : b }}`.
- **Loops:** `for: { each: $list, as: item }`; `{{index}}` is available inside.
- **Operators:** comparison (`== != < <= > >=`, where `==` means a *strict* equality), logical
  (`&& || !`), nullish (`??`), arithmetic (`+ - * / %`), and a ternary `? :`. Optional chaining
  (`$a?.b`) short-circuits on a missing value.
- **Helpers:** whitelisted pure functions only — `formatCurrency`, `formatDate`, row-builders. No
  `eval`, no arbitrary code. Reading `__proto__` / `constructor` / `prototype` is blocked.

### What may go inline vs in a Derivation

`if`/`for` may only **directly read** a payload or `$derived` field, including an equality/boolean
test on a scalar (`if: $borrowerType == "SOLE_TRADER"`). Anything **computed** — arithmetic,
collection operations (`.length`, `.some`), multi-field logic, choosing a clause version — **must** be
a Derivation. This keeps templates declarative and the logic testable.

### Articles and lists

An `article` has a number, an optional `heading`, and a `body` of further items (it may nest):

```yaml
- article:
    no: "1."
    heading: "Definitions"
    body:
      - paragraph: "In this contract the following terms apply."
```

A `numberedList` / `bulletList` / `alphaList` takes a list of items, where **each item is itself a
list of body items**:

```yaml
- numberedList:
    - [{ paragraph: "First point." }]
    - [{ clause: "warranty@latest", vars: { ... } }]
```

## Writing a Clause

A **Clause** is a named, versioned, locale-aware piece of reusable legal text. There is only one text
element — no "snippet" vs "clause" decision to make (see ADR-0002). A one-line phrase and a multi-page
passage are both Clauses.

```yaml
clause: counterparts
version: 1
locale: cs
vars:                                    # this clause's own typed mini-schema
  count: { type: integer, min: 1 }
text: |
  This document is executed in {{count}} counterparts, each party receiving one.
```

- Content is **rich-text** (`RichTextV1`) with `{{placeholder}}` tokens; a trivial clause is just one
  paragraph.
- Each Clause declares the schema for **its own `vars`**; the template maps a payload slice into them,
  and the integrity lint checks the mapping is type-correct.
- **Editing wording = a new version.** Templates that reference `@latest` pick it up automatically;
  templates that pin `@vN` keep the old wording until updated. Either way, a generated document's
  **Snapshot** freezes the exact version used.

## Locale

Clauses are **locale-aware**: a version is stored per language as `clauses/<id>/v<N>.<locale>.yaml`
(e.g. `welcome-note/v1.en.yaml` and `welcome-note/v1.cs.yaml`). A Template declares a default `locale`,
but a consumer can **override it per render**:

```ts
renderDocument({ catalog, template: "localized", format: "html" });               // template's locale
renderDocument({ catalog, template: "localized", locale: "cs", format: "html" }); // → Czech clauses
```

The requested locale drives Clause resolution. If a Clause has no file for that locale, it **falls
back** to an available locale of the same version (so a partially-translated catalog still renders).
The **Snapshot** freezes the locale that was requested, so re-render stays deterministic. The same
Theme drives every locale — translation is content, not styling.

## Derivations

When a value must be *computed* from the payload, declare it as a **Derivation** — a named, pure
function over the payload, registered in the Helper registry. Results land on `$derived.*` and are
read uniformly by templates and clauses.

```
counterpartsCount = parties.length + 1
hasAccessionDebtor = parties.some(p => p.role === "accessionDebtor")
securityClause     = parties.length >= 3 ? "security.3party@v2" : "security.2party@v1"
```

A template then reads the derived value when referencing a clause:

```yaml
  - clause: counterparts   vars: { count: $derived.counterpartsCount }
```

Derivations are unit-testable in isolation (input payload → expected `$derived` values) and are
snapshotted with the document, so an audit shows both the raw input and the values that shaped the
output.

## Variants & families (reach for these last)

Most differences between similar documents are **data-driven** and need no variant: loop the parties
with `for: $parties`, gate optional sections with `if:`, and let a Derivation choose clause versions.
Reach for a named **Variant** only when the *authored structure itself* genuinely diverges.

A family is a directory: a `base.yaml` plus one file per Variant.

```
templates/pledge-agreement/
  base.yaml          # declares Slots, iterates for: $parties, gates with if:
  two-party.yaml
  three-party.yaml
```

```yaml
# templates/pledge-agreement/base.yaml
base: pledge-agreement
version: 1
locale: en
body:
  - title: "PLEDGE AGREEMENT"
  - slot: security              # a named Slot — a Variant fills this
  - for: { each: "$parties", as: p }
    body:
      - partyHeader: { party: "$p", roleLabel: "Party" }
```

```yaml
# templates/pledge-agreement/three-party.yaml
variant: three-party
extends: pledge-agreement        # matches the base's `base:` (may be omitted — defaults to the dir)
parties: [lender, pledgor, accessionDebtor]
overrides:                       # keyed by Slot name; each value is a list of body items
  security:
    - clause: security.3party@v2
```

The **Base template** declares **Slot**s (`- slot: <name>`) and iterates `for: $parties`; a
**Variant** `extends` it, declares its parties, and **fills or replaces** only the Slots it names.
Each `overrides` value is a body-item list. A Variant may only fill Slots the Base declares (an
unknown Slot is an error), and a Slot left unfilled is simply omitted. Shared fragments go in an
**Include**. Wording differences ride on Clause versions, not on copied templates.

## Validation & propagation

- Run `catalog.validate()` (also in CI) — it checks every Block/Clause/Include reference resolves,
  every helper is registered, and every element's `vars` typecheck against the payload. Errors are
  path-precise.
- `catalog.clauses.diff("aml.intro", { from: 2, to: 3 })` returns a structured, paragraph-level diff
  between two clause versions (added / removed / replaced blocks); human-readable HTML rendering of
  that diff arrives with the HTML renderer.

## What you cannot do

- Write arbitrary code in a template or clause — only whitelisted helpers and declared Derivations.
- Compute values inline in `if`/`for` — extract them to a Derivation.
- Reference an element or helper that is not registered — the lint blocks it.

## See also

- [`CONTEXT.md`](./CONTEXT.md) — exact meaning of every term used here.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how the engine turns your files into a document.
