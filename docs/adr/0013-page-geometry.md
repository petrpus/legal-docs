# Page geometry: named formats, orientation & template-over-theme precedence

Every document effectively rendered as A4 portrait: the theme's size enum stopped at `LETTER`, only
the PDF renderer read it, the DOCX section carried **no** page properties at all (Word silently
applied its own defaults regardless of the theme), and orientation was not expressible anywhere.
US-format documents (Letter, Legal) and wide content (a landscape annex with a table) had no home.
This ADR fixes how page geometry is declared, defaulted, and rendered.

## Decision

**A standard named-format set, one dimension table.** `theme.page.size` widens to six named formats —
`A3 | A4 | A5 | LETTER | LEGAL | TABLOID` — and `theme.page` gains
`orientation: "portrait" | "landscape"` (default `A4` / `portrait`, so existing output is unchanged).
The formats live in one core `PAGE_SIZES` table (points, portrait reference) whose values **match
react-pdf's internal table exactly**: PDF resolves the name natively, DOCX converts the same numbers
to twips, so the two paged formats can never disagree. Arbitrary `width`/`height` numbers are
deliberately not supported — named formats keep authoring, validation, and cross-renderer parity
trivial; a genuinely custom size is a future extension, not a hole to leave open now.

**Declared on the Template when it is a requirement, defaulted by the Theme otherwise.** A Template
gains an optional `page: { size?, orientation? }` (`PageSetup`) — mirroring ADR-0011's furniture
stance: what the *document requires* belongs on the Template, what the *house style prefers* belongs
in the Theme. The template **wins per-field**: a landscape annex must not render portrait because a
consumer's theme says so — required geometry is content, not styling. The precedence lives in exactly
one place, `effectivePage(theme, override)`; renderers never combine the two sources themselves.
Values are static enums validated at catalog load (`Object.hasOwn`-guarded against prototype-key
YAML), with **no interpolation** — geometry must be knowable without a payload.

**Frozen in the Snapshot, additively.** `DocumentTree` gains `page?: PageSetup`, carried verbatim by
assembly and frozen in the snapshot `tree` like furniture. The digest mixes `page` in **only when
present**, so page-less documents keep their pre-feature snapshot ids (pinned by a golden-id test);
`SNAPSHOT_SCHEMA_VERSION` stays 2 — an optional additive field is not a breaking shape change.

**DOCX emits explicit section geometry (behaviour change).** The DOCX section now always carries
`w:pgSz` (portrait dimensions from `PAGE_SIZES`; the docx library swaps `w:w`/`w:h` for landscape
itself) and `w:pgMar` with the single `theme.page.padding` token on all four edges, mirroring the PDF
renderer's uniform Page padding. This intentionally replaces Word's implicit defaults (Letter-ish
size, 1-inch margins) that previous output silently inherited — the first render after this change
shifts DOCX margins from 1440 to 960 twips under the default theme. Accepted: output now matches the
theme and the PDF, which was always the contract's intent (ADR-0007 parity).

**HTML stays exempt.** The HTML renderer is a page-less fragment (ADR-0006); `page` joins
`theme.page.*` and furniture in the documented "paged output only" set.

## Consequences

- Per-edge margins remain a single `padding` token; mixed portrait/landscape within one document
  (OOXML multi-section, react-pdf multi-`Page`) is out of scope until a real need appears.
- Variant/family composition does not carry `page` — the same known limitation as furniture
  (`composeTemplate` drops base furniture today); both should be lifted together.
- The demo theme editor exposes `page.size` and `page.orientation` as value-detected enum selects.
- Public surface: `PAGE_SIZES`, `effectivePage`, `isPageSizeName`, `PageSizeName`,
  `PageOrientation`, `PageSetup`.
