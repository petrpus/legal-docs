import type { Align } from "./core/document-tree";

/**
 * The default font family. The PDF renderer registers a bundled diacritics-safe serif (Liberation
 * Serif, OFL) under this name; HTML/DOCX fall back to the viewer's fonts. Defined here (not in the
 * react-pdf font module) so `Theme` stays renderer-independent.
 */
export const DEFAULT_FONT_FAMILY = "LegalDocs Serif";

/**
 * Theme tokens read by every renderer (PDF / HTML / DOCX). The consumer can override the theme;
 * renderers never read hard-coded styling. See docs/THEMING.md for how each renderer maps the tokens.
 */
export interface Theme {
  page: { size: "A4" | "LETTER"; padding: number };
  /** Font family. PDF needs it registered (bundled by default, or `Font.register` your own); HTML/DOCX use the viewer's fonts. */
  font: { family: string };
  fontSize: { title: number; paragraph: number };
  color: { text: string };
  /** Default text alignment per block kind; a per-block `align` override wins (ADR-0008). */
  align: { title: Align; paragraph: Align };
  /**
   * Default paragraph indentation (pt): `firstLine` indents the first line, `block` shifts the whole
   * paragraph's left edge. Titles have no indent default (0); a per-block override wins (ADR-0008).
   */
  indent: { firstLine: number; block: number };
  spacing: { paragraph: number; title: number };
  /** Page header/footer presentation (paged output only). `margin` is the distance (pt) from the page edge. */
  header: { fontSize: number; color: string; margin: number };
  footer: { fontSize: number; color: string; margin: number };
  article: {
    /** Heading font size by level (1-based, capped at 3). */
    headingFontSize: readonly [number, number, number];
    indentPerLevel: number;
    gap: number;
  };
  list: { indent: number; markerGap: number; gap: number };
  partyHeader: { roleFontSize: number; gap: number };
  table: { borderColor: string; cellPadding: number; labelWidth: number; fontSize: number };
  signatures: {
    lineWidth: number;
    lineColor: string;
    lineSpace: number;
    columnGap: number;
    gap: number;
    fontSize: number;
    roleColor: string;
  };
}

export const defaultTheme: Theme = {
  page: { size: "A4", padding: 48 },
  font: { family: DEFAULT_FONT_FAMILY },
  fontSize: { title: 18, paragraph: 11 },
  color: { text: "#111111" },
  align: { title: "left", paragraph: "left" },
  indent: { firstLine: 0, block: 0 },
  spacing: { paragraph: 8, title: 16 },
  header: { fontSize: 9, color: "#666666", margin: 24 },
  footer: { fontSize: 9, color: "#666666", margin: 24 },
  article: { headingFontSize: [13, 12, 11], indentPerLevel: 14, gap: 6 },
  list: { indent: 14, markerGap: 6, gap: 4 },
  partyHeader: { roleFontSize: 11, gap: 8 },
  table: { borderColor: "#999999", cellPadding: 4, labelWidth: 140, fontSize: 10 },
  signatures: {
    lineWidth: 1,
    lineColor: "#111111",
    lineSpace: 28,
    columnGap: 24,
    gap: 16,
    fontSize: 10,
    roleColor: "#555555",
  },
};

/** A recursively-optional shape of `T`. Arrays/tuples are treated as leaves (override the whole value). */
export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/**
 * Deep-merge a partial theme over {@link defaultTheme}, so a consumer can override a single token
 * without re-spreading every group: `mergeTheme({ fontSize: { title: 22 } })`. Arrays (e.g.
 * `article.headingFontSize`) are replaced wholesale, not merged element-by-element. The result is
 * not a deep clone — untouched groups alias `defaultTheme`'s objects (and no arg returns the
 * `defaultTheme` singleton), so treat the returned Theme as read-only, as every renderer does.
 */
export function mergeTheme(partial?: DeepPartial<Theme>): Theme {
  return partial ? (deepMerge(defaultTheme as unknown as Record<string, unknown>, partial as Record<string, unknown>) as unknown as Theme) : defaultTheme;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const o = override[key];
    const b = base[key];
    out[key] =
      o !== null && typeof o === "object" && !Array.isArray(o) && b !== null && typeof b === "object" && !Array.isArray(b)
        ? deepMerge(b as Record<string, unknown>, o as Record<string, unknown>)
        : o;
  }
  return out;
}
