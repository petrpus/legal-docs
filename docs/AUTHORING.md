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
└── partials/                          # shared Includes (referenced via `include:`)
    └── party-block-set.yaml
```

## Writing a Template

A Template is a declarative tree. Its `body` is a list of items; each item is inline text
(`title`/`paragraph`), a `clause` reference, an `article`, a list, a Block (`partyHeader`,
`keyValueTable`, `signatures`), a control structure (`if`/`for`), an `include`, a `slot`, or the
`custom` escape hatch. (These are fixed body-item kinds — there is no separate "block registry".)

```yaml
template: loan-notice
version: 1
locale: en
payloadSchema: loan-notice@1              # code-side zod schema this document validates against (optional)
derivations: [counterpartsCount]          # names of code-side Derivations → $derived.*
body:
  - title: "LOAN NOTICE"                                    # inline literal (string shorthand)
  - title: { text: "SCHEDULE 1", align: center }            # object form adds per-block style (ADR-0008)
  - partyHeader: { party: "$borrower", roleLabel: "Borrower" }
  - paragraph: "Executed in {{ $derived.counterpartsCount }} counterparts."  # $derived.* from a Derivation
  - clause: "declaration.intro@v2"                          # pinned clause version
  - article:
      no: "1."
      heading: "Definitions"
      body:
        - clause: "loan.request@latest"                     # newest published version
          vars: { loan: "$loan" }                           # map a payload slice into the clause's vars
  - for: { each: "$warranties", as: w }                     # loop a payload list; $index is the counter
    body:
      - paragraph: "Warranty {{ $index + 1 }}: {{ $w }}."
  - if: "$borrowerType == 'SOLE_TRADER'"                    # condition — comparison / logical ops
    then:
      - clause: "sole.warranties.lead@v1"
  - signatures: { places: [{ party: "$borrower", role: "Borrower" }] }

  # Special-layout document: drop into a renderer-native Custom block (ADR-0005)
  # - custom: { component: "landscape-grid-note", props: "$note" }
```

`for` and `if` take a sibling `body:` / `then:`(+`else:`) list; the loop variable is `$<as>` and the
counter is `$index`. A `clause`/`article` item carries its `vars`/`body` as sibling keys.

### Styling a title or paragraph (alignment & indentation)

`title` and `paragraph` accept either the string shorthand or an object form that adds per-block
style. The object's `text` is still interpolated; the style props are static (ADR-0008):

```yaml
body:
  - title: "PLEDGE AGREEMENT"                                     # shorthand — left, no indent
  - title:     { text: "PLEDGE AGREEMENT", align: center }        # centred heading
  - paragraph: { text: "{{ $recital }}", align: justify,          # justified…
                 indent: 24, firstLineIndent: 18 }                # …left-indented 24pt, first line +18pt
```

- **`align`** — `left | center | right | justify`.
- **`indent`** — block left indent in **design points** (shifts the whole paragraph). Non-negative.
- **`firstLineIndent`** — first-line indent in design points. Non-negative (negative outdent is deferred).

Omit any of them to inherit the Theme default (`theme.align.*`, `theme.indent.{firstLine,block}` —
titles have no indent default). A per-block value overrides the default. All three apply consistently
across PDF, HTML and DOCX. (Alignment/indent on a list-item paragraph is honoured by PDF and HTML but
not by DOCX, whose flat list model doesn't carry it — see ADR-0007/0008.)

### Page headers & footers (paged output)

A Template may declare a `header` and/or `footer`, each with `left` / `center` / `right` slots. Slots
are interpolated like body text, and two reserved tokens place page numbers:

```yaml
header:
  left: "{{ $party.name }}"
  right: "{{ $page.number }} / {{ $page.total }}"
footer:
  center: "Confidential"
```

- `{{ $page.number }}` / `{{ $page.total }}` are filled **per page** by the renderer; `$page` is a
  reserved slot-scope name (it shadows a payload field literally named `page`, inside furniture only).
- Presentation (`fontSize`, `color`, `margin`) lives in `theme.header` / `theme.footer`.
- **Paged output only:** PDF renders furniture; the HTML fragment renderer ignores it (it has no pages),
  exactly as it ignores `theme.page.*`. See ADR-0011.

### Expression syntax

- **Values:** `$path.to.value` (from the payload), `$derived.name` (from the Resolve phase),
  `{{ expr }}` inside text.
- **Conditionals:** `if: … then: … else: …`, inline `{{ flag ? a : b }}`.
- **Loops:** `for: { each: $list, as: item }` with a sibling `body:`; `{{ $index }}` is the counter.
- **Operators:** comparison (`== != < <= > >=`, where `==` means a *strict* equality), logical
  (`&& || !`), nullish (`??`), arithmetic (`+ - * / %`), and a ternary `? :`. Optional chaining
  (`$a?.b`) short-circuits on a missing value.
- **Helpers:** whitelisted pure functions only — deterministic `formatCurrency` / `formatDate` (ISO,
  audit-stable), locale-aware `formatMoney` / `formatDateLong` (`Intl`, formatted for the render locale),
  row-builders. No `eval`, no arbitrary code. Reading `__proto__` / `constructor` / `prototype` is
  blocked. See ADR-0010 for the deterministic-vs-locale-aware split.

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
  This document is executed in **{{ $count }}** counterparts, each party receiving one.
```

- Content is **rich-text** (`RichTextV1`) with `{{ $placeholder }}` tokens; a trivial clause is just one
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
