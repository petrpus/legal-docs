import type { Theme } from "../theme";

/**
 * The standard page formats, as portrait dimensions in points. The values match react-pdf's internal
 * size table exactly, so the DOCX renderer (which needs explicit dimensions) and the PDF renderer
 * (which resolves the name itself) produce the same page geometry.
 */
export const PAGE_SIZES = {
  A3: { width: 841.89, height: 1190.55 },
  A4: { width: 595.28, height: 841.89 },
  A5: { width: 419.53, height: 595.28 },
  LETTER: { width: 612, height: 792 },
  LEGAL: { width: 612, height: 1008 },
  TABLOID: { width: 792, height: 1224 },
} as const;

export type PageSizeName = keyof typeof PAGE_SIZES;

/** Whether a string names a supported page format (authoring validation, config UIs). */
export function isPageSizeName(value: string): value is PageSizeName {
  // Own keys only — `in` would also accept prototype keys like "constructor" from hostile YAML.
  return Object.hasOwn(PAGE_SIZES, value);
}

export type PageOrientation = "portrait" | "landscape";

/** A page-geometry declaration; each field is optional so a declarer states only its actual constraint. */
export interface PageSetup {
  size?: PageSizeName;
  orientation?: PageOrientation;
}

/**
 * The page geometry a paged renderer must use: `theme.page` provides the defaults, an `override`
 * (a template's `page:` declaration, carried on the DocumentTree) wins per-field — a document
 * designed for a specific geometry is a content requirement, not styling. This helper is the single
 * home of that precedence rule; renderers never combine the two sources themselves.
 */
export function effectivePage(theme: Theme, override?: PageSetup): { size: PageSizeName; orientation: PageOrientation } {
  return {
    size: override?.size ?? theme.page.size,
    orientation: override?.orientation ?? theme.page.orientation,
  };
}
