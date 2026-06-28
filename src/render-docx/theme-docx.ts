/**
 * Convert Theme tokens (treated as points) to the units the `docx` library expects (ADR-0007):
 * font sizes → half-points, spacing/indent → twips (dxa), border widths → eighths of a point.
 */
export function halfPoints(pt: number): number {
  return Math.round(pt * 2);
}

export function twips(pt: number): number {
  return Math.round(pt * 20);
}

export function eighths(pt: number): number {
  return Math.round(pt * 8);
}
