/**
 * Theme tokens read by the PDF renderer. The consumer can override the theme; renderers never read
 * hard-coded styling. Tokens grow as Blocks (articles, tables, signatures) land in later slices.
 */
export interface Theme {
  page: { size: "A4" | "LETTER"; padding: number };
  fontSize: { title: number; paragraph: number };
  color: { text: string };
  spacing: { paragraph: number; title: number };
}

export const defaultTheme: Theme = {
  page: { size: "A4", padding: 48 },
  fontSize: { title: 18, paragraph: 11 },
  color: { text: "#111111" },
  spacing: { paragraph: 8, title: 16 },
};
