# Theming

Every renderer reads styling from a configurable **Theme** — never from hard-coded values. Pass a
custom theme per render; the same Theme drives PDF, HTML and DOCX, so you configure styling once and
each renderer interprets the tokens in its own units.

## Passing a custom theme

`theme` accepts a **partial** — any subset of tokens, at any depth. `renderDocument`/`renderFromSnapshot`
and the three tree renderers all deep-merge it over `defaultTheme` via `mergeTheme`, so you override
one token without re-spreading the eleven other groups:

```ts
import { renderDocument } from "@petrpus/legal-docs";

await renderDocument({
  catalog, template: "agreement", data, format: "pdf",
  theme: { fontSize: { title: 22 }, color: { text: "#0a0a0a" } },
});
```

Omit `theme` to use `defaultTheme` unchanged. Arrays (e.g. `article.headingFontSize`) are replaced
wholesale, not merged element-by-element. To merge a partial yourself (e.g. for a UI theme editor that
needs the resolved `Theme` before rendering), call `mergeTheme` directly:

```ts
import { mergeTheme, type DeepPartial, type Theme } from "@petrpus/legal-docs";

const partial: DeepPartial<Theme> = { fontSize: { title: 22 } };
const resolved: Theme = mergeTheme(partial); // every other token still equals defaultTheme's
```

## Token surface

The `Theme` type (all sizes are **design points**; see units below):

| Group | Tokens | Drives |
|---|---|---|
| `page` | `size` (`"A3"` \| `"A4"` \| `"A5"` \| `"LETTER"` \| `"LEGAL"` \| `"TABLOID"`), `orientation` (`"portrait"` \| `"landscape"`), `padding` | Default page geometry (paged output only — see **Page geometry** below). |
| `font` | `family` | Font family (see **Fonts & diacritics** below). |
| `fontSize` | `title`, `paragraph` | Title and body text size. |
| `color` | `text` | Base text colour (hex). |
| `align` | `title`, `paragraph` (`"left"` \| `"center"` \| `"right"` \| `"justify"`) | Default text alignment; a per-block `align` override wins (see AUTHORING.md, ADR-0008). |
| `indent` | `firstLine`, `block` | Default paragraph indentation (first-line / block left); a per-block `indent`/`firstLineIndent` override wins. Titles have no indent default. |
| `spacing` | `paragraph`, `title` | Bottom margin after paragraphs / the title. |
| `header` | `fontSize`, `color`, `margin` | Page header presentation (paged output only — see **Page headers & footers** below). |
| `footer` | `fontSize`, `color`, `margin` | Page footer presentation (paged output only). |
| `article` | `headingFontSize` (by level 1–3), `indentPerLevel`, `gap` | Article heading size, nesting indent, block gap. |
| `list` | `indent`, `markerGap`, `gap` | List indent, marker gap, item gap. |
| `partyHeader` | `roleFontSize`, `gap` | Party role label size and block gap. |
| `table` | `borderColor`, `cellPadding`, `labelWidth`, `fontSize` | Key-value table styling. |
| `signatures` | `lineWidth`, `lineColor`, `lineSpace`, `columnGap`, `gap`, `fontSize`, `roleColor` | Signature lines and labels. |

## Page geometry (paged output)

`theme.page` sets the **default** geometry: one of six named formats (`A3`–`A5`, `LETTER`, `LEGAL`,
`TABLOID`), an `orientation`, and a uniform `padding`. A Template that requires a specific geometry
(a landscape annex, a Legal filing) declares it in its own `page:` section, which **overrides the
theme per-field** — required geometry is content, not styling (see AUTHORING.md and ADR-0013).

- **PDF** resolves the format name and orientation natively; `padding` is the Page padding.
- **DOCX** emits explicit section properties: `w:pgSz` from the shared `PAGE_SIZES` dimension table
  (identical to react-pdf's, so the two formats always agree) and `w:pgMar` with `padding` on all
  four edges. Before ADR-0013 the DOCX section carried no page properties at all and Word applied
  its own defaults (Letter-ish size, 1-inch margins) — output is now explicit and theme-driven.
- **HTML** ignores `theme.page.*` entirely (a page-less fragment, ADR-0006/0011).

The dimension table and the precedence rule are public: `PAGE_SIZES`, `effectivePage`,
`isPageSizeName`, and the `PageSizeName` / `PageOrientation` / `PageSetup` types.

## Fonts & diacritics

`theme.font.family` names the font. The three renderers resolve fonts very differently:

- **PDF** embeds its own font. react-pdf's built-in Helvetica is WinAnsi-only and **mangles
  Latin-Extended diacritics** — *"Příliš žluťoučký kůň"* comes out as *"PYíliš žlueou ký koH"*. So the
  library **bundles a diacritics-safe serif (Liberation Serif, SIL OFL)** and registers it under the
  default family `"LegalDocs Serif"` automatically. Czech (and the rest of Latin-Extended) renders
  correctly out of the box.
- **HTML** uses the viewer's fonts — the CSS is `font-family: "<family>", Georgia, "Times New Roman", serif`.
- **DOCX** sets the document-default run font to `<family>`; the reader (Word, …) substitutes if absent.

**Using your own font in PDF** — register it, then point the theme at it:

```ts
import { Font, renderDocument } from "@petrpus/legal-docs";

Font.register({ family: "Brand Serif", fonts: [
  { src: "./fonts/Brand-Regular.ttf" },
  { src: "./fonts/Brand-Bold.ttf", fontWeight: "bold" },
]});

await renderDocument({
  catalog, template: "…", format: "pdf",
  theme: { font: { family: "Brand Serif" } }, // a partial — mergeTheme fills in the rest
});
```

Register a bold and italic face so bold/italic runs keep their diacritics. `registerBundledFonts()` (the
default) is idempotent and re-registerable.

## How each renderer interprets the tokens

Numeric tokens are **design points (pt)**. Each renderer maps them to its native units:

| Renderer | Font sizes | Lengths (spacing, indent, widths) | Borders |
|---|---|---|---|
| **PDF** (`@react-pdf/renderer`) | pt directly | pt directly | pt |
| **HTML** | `px` (≈ pt at these sizes; a preview approximation) | `px` | `px` |
| **DOCX** (`docx`) | half-points (× 2) | twips (× 20) | eighths of a point (× 8) |

The DOCX renderer uses the conversion helpers exported for consumers writing a `docx` Custom block:

```ts
import { halfPoints, twips, eighths } from "@petrpus/legal-docs";
```

## Page headers & footers

A Template may declare `header`/`footer` slots (`{ left?, center?, right? }`, interpolated like body
text — see [`AUTHORING.md`](AUTHORING.md)); `theme.header`/`theme.footer` style them. Paged output only:

```ts
// theming
theme: { header: { fontSize: 9, color: "#666666" }, footer: { margin: 30 } }
```

- **PDF** renders furniture as a `fixed`, repeated three-column row.
- **DOCX** renders it as a section `Header`/`Footer`; `{{ $page.number }}`/`{{ $page.total }}` become
  native Word `PAGE`/`NUMPAGES` fields (stay live if the document is edited).
- **HTML** ignores furniture — it's a page-less fragment, exactly like it ignores `theme.page.*`.

See ADR-0011 for the full design (the `$page` reserved namespace, Snapshot freezing).

## Notes

- **HTML** emits a self-contained `<div class="legal-doc">` fragment with a scoped `<style>` generated
  from the theme; restyle by overriding the theme or with your own CSS targeting the `.legal-doc`
  classes.
- **Fidelity differs by format** — the HTML view is a semantic preview and DOCX is an editable, flat
  approximation of the PDF layout, not a pixel copy. Theme tokens keep the three outputs visually
  consistent at the level of sizes and colours.
- A **Custom block** receives the resolved `theme` in its render context (`(props, { theme }) => …`),
  so special-layout blocks stay on-theme too.
