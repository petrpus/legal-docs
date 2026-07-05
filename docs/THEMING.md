# Theming

Every renderer reads styling from a configurable **Theme** — never from hard-coded values. Pass a
custom theme per render; the same Theme drives PDF, HTML and DOCX, so you configure styling once and
each renderer interprets the tokens in its own units.

## Passing a custom theme

```ts
import { renderDocument, defaultTheme, type Theme } from "@petrpus/legal-docs";

const theme: Theme = {
  ...defaultTheme,
  fontSize: { ...defaultTheme.fontSize, title: 22 },
  color: { text: "#0a0a0a" },
};

await renderDocument({ catalog, template: "agreement", data, theme, format: "pdf" });
```

Omit `theme` to use `defaultTheme`. A theme is a plain object — start from `defaultTheme` and override
the tokens you care about.

## Token surface

The `Theme` type (all sizes are **design points**; see units below):

| Group | Tokens | Drives |
|---|---|---|
| `page` | `size` (`"A4"` \| `"LETTER"`), `padding` | Page geometry (PDF). |
| `fontSize` | `title`, `paragraph` | Title and body text size. |
| `color` | `text` | Base text colour (hex). |
| `align` | `title`, `paragraph` (`"left"` \| `"center"` \| `"right"` \| `"justify"`) | Default text alignment; a per-block `align` override wins (see AUTHORING.md, ADR-0008). |
| `spacing` | `paragraph`, `title` | Bottom margin after paragraphs / the title. |
| `article` | `headingFontSize` (by level 1–3), `indentPerLevel`, `gap` | Article heading size, nesting indent, block gap. |
| `list` | `indent`, `markerGap`, `gap` | List indent, marker gap, item gap. |
| `partyHeader` | `roleFontSize`, `gap` | Party role label size and block gap. |
| `table` | `borderColor`, `cellPadding`, `labelWidth`, `fontSize` | Key-value table styling. |
| `signatures` | `lineWidth`, `lineColor`, `lineSpace`, `columnGap`, `gap`, `fontSize`, `roleColor` | Signature lines and labels. |

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

## Notes

- **HTML** emits a self-contained `<div class="legal-doc">` fragment with a scoped `<style>` generated
  from the theme; restyle by overriding the theme or with your own CSS targeting the `.legal-doc`
  classes.
- **Fidelity differs by format** — the HTML view is a semantic preview and DOCX is an editable, flat
  approximation of the PDF layout, not a pixel copy. Theme tokens keep the three outputs visually
  consistent at the level of sizes and colours.
- A **Custom block** receives the resolved `theme` in its render context (`(props, { theme }) => …`),
  so special-layout blocks stay on-theme too.
