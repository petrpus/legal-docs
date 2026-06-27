/**
 * The Helper registry: whitelisted pure functions callable from template expressions (and, later,
 * Derivations). Code-side — not part of the Catalog. No arbitrary code runs; only registered helpers.
 */
export type Helper = (...args: unknown[]) => unknown;
export type HelperRegistry = Record<string, Helper>;

export const defaultHelpers: HelperRegistry = {
  formatCurrency: (...args) => {
    const amount = Number(args[0]);
    const currency = String(args[1] ?? "");
    if (Number.isNaN(amount)) throw new Error("formatCurrency: amount is not a number");
    return `${currency} ${amount.toFixed(2)}`.trim();
  },
  formatDate: (...args) => {
    const date = new Date(String(args[0]));
    if (Number.isNaN(date.getTime())) throw new Error("formatDate: invalid date");
    return date.toISOString().slice(0, 10);
  },
};
