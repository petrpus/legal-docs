/**
 * Theme tokens read by the PDF renderer. The consumer can override the theme; renderers never read
 * hard-coded styling. Tokens grow as Blocks (articles, tables, signatures) land in later slices.
 */
export interface Theme {
  page: { size: "A4" | "LETTER"; padding: number };
  fontSize: { title: number; paragraph: number };
  color: { text: string };
  spacing: { paragraph: number; title: number };
  article: {
    /** Heading font size by level (1-based, capped at 3). */
    headingFontSize: readonly [number, number, number];
    indentPerLevel: number;
    gap: number;
  };
  list: { indent: number; markerGap: number; gap: number };
  partyHeader: { roleFontSize: number; gap: number };
  table: { borderColor: string; cellPadding: number; labelWidth: number; fontSize: number };
}

export const defaultTheme: Theme = {
  page: { size: "A4", padding: 48 },
  fontSize: { title: 18, paragraph: 11 },
  color: { text: "#111111" },
  spacing: { paragraph: 8, title: 16 },
  article: { headingFontSize: [13, 12, 11], indentPerLevel: 14, gap: 6 },
  list: { indent: 14, markerGap: 6, gap: 4 },
  partyHeader: { roleFontSize: 11, gap: 8 },
  table: { borderColor: "#999999", cellPadding: 4, labelWidth: 140, fontSize: 10 },
};
