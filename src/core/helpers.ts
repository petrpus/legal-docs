/**
 * The Helper registry: whitelisted pure functions callable from template expressions (and, later,
 * Derivations). Code-side — not part of the Catalog. No arbitrary code runs; only registered helpers.
 */
import { LegalDocsError } from "./errors";
export type Helper = (...args: unknown[]) => unknown;
export type HelperRegistry = Record<string, Helper>;

/**
 * Build the built-in helper registry, optionally bound to a `locale` for the locale-aware members.
 *
 * The library ships two flavours on purpose:
 * - **Deterministic** (`formatDate` ISO `YYYY-MM-DD`, `formatCurrency` `"EUR 1000.00"`) — output never
 *   depends on `locale` or the host's ICU version, so they are safe in audit-frozen / golden output.
 * - **Locale-aware** (`formatDateLong`, `formatMoney`) — use `Intl` bound to `locale`; presentation
 *   varies by locale (and, in principle, ICU version), so keep them out of byte-stable golden artifacts.
 *
 * The engine calls this with the render locale; {@link defaultHelpers} is the locale-neutral registry
 * (used for helper-name registration in `validate()` and as a back-compatible export).
 */
export function makeDefaultHelpers(locale?: string): HelperRegistry {
  return {
    formatCurrency: (...args) => {
      const amount = Number(args[0]);
      const currency = String(args[1] ?? "");
      if (Number.isNaN(amount)) throw new LegalDocsError("formatCurrency: amount is not a number");
      return `${currency} ${amount.toFixed(2)}`.trim();
    },
    formatDate: (...args) => {
      const date = new Date(String(args[0]));
      if (Number.isNaN(date.getTime())) throw new LegalDocsError("formatDate: invalid date");
      return date.toISOString().slice(0, 10);
    },
    formatDateLong: (...args) => {
      const date = new Date(String(args[0]));
      if (Number.isNaN(date.getTime())) throw new LegalDocsError("formatDateLong: invalid date");
      try {
        // UTC time zone keeps the calendar day stable (mirrors formatDate), so only the *presentation*
        // is locale-dependent, not which day is shown.
        return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(date);
      } catch (cause) {
        // A malformed locale makes Intl throw a raw RangeError; surface it as a typed library error.
        throw new LegalDocsError(`formatDateLong: invalid locale "${String(locale)}"`, { cause });
      }
    },
    formatMoney: (...args) => {
      const amount = Number(args[0]);
      const currency = String(args[1] ?? "");
      if (Number.isNaN(amount)) throw new LegalDocsError("formatMoney: amount is not a number");
      if (!currency) throw new LegalDocsError("formatMoney: currency is required");
      try {
        return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
      } catch (cause) {
        // Intl throws a raw RangeError on an invalid currency code or locale — wrap it as a typed error.
        throw new LegalDocsError(`formatMoney: invalid currency "${currency}" or locale "${String(locale)}"`, { cause });
      }
    },
  };
}

/** The locale-neutral built-in helper registry (locale-aware members use the host default locale). */
export const defaultHelpers: HelperRegistry = makeDefaultHelpers();
