# Locale-aware helpers: opt-in `Intl`, deterministic by default

The built-in helpers `formatDate` (ISO `YYYY-MM-DD`) and `formatCurrency` (`"EUR 1000.00"`) are
locale-independent by design. Documents are increasingly authored for a specific `locale` (already a
first-class render input that pins into the Snapshot), so authors want dates and money **formatted for
that locale** — `1. července 2026`, `1 000,00 €`. This ADR fixes how locale reaches a helper and why the
naive helpers are kept rather than replaced.

## Decision

**Two flavours, side by side — deterministic stays the default.**
- **Deterministic** (`formatDate`, `formatCurrency`) — output never depends on `locale` or the host's
  ICU version. Safe inside audit-frozen documents and byte-stable golden/parity tests. **Unchanged.**
- **Locale-aware** (`formatDateLong`, `formatMoney`) — use `Intl.DateTimeFormat` / `Intl.NumberFormat`
  bound to the render locale. Presentation varies by locale and, in principle, by the host's ICU
  version, so these are kept **out** of byte-stable golden artifacts and asserted tolerantly in tests.

**Locale reaches helpers by binding, not by a type change.** A new `makeDefaultHelpers(locale?)` builds
the registry with `locale` closed into the `Intl` calls. The **engine** — the single place the default
helpers are merged and which already holds the resolved `locale` — calls `makeDefaultHelpers(locale)`
(consumer `helpers` still win on a name collision). The public `Helper`
(`(...args) => unknown`) and `EvalContext` types are **unchanged**: no trailing context argument (which
would be a footgun for variadic helpers) and no widened signature (which would break every existing
helper). `defaultHelpers` remains exported as the locale-neutral registry — used for helper-name
registration in `validate()` and as a back-compatible default.

**Day stability.** `formatDateLong` formats with `timeZone: "UTC"`, mirroring `formatDate`, so only the
*presentation* is locale-dependent — never *which* calendar day is shown.

## Consequences

- Authors get `{{ formatMoney($price.amount, $price.currency) }}` and `{{ formatDateLong($signedOn) }}`,
  formatted for the document's locale, with zero new API to learn.
- A consumer wanting a locale-aware **custom** helper closes over their own locale (they know their
  render locale) — the library only binds locale into *its own* built-ins. This keeps custom helpers
  pure functions, consistent with the "no arbitrary code / whitelisted only" stance.
- Golden and parity tests stay reproducible because the audit-facing helpers are deterministic; the
  `Intl`-based helpers are exercised with locale-difference and tolerant assertions instead.
- Alternatives rejected: **replacing** `formatDate`/`formatCurrency` with `Intl` (breaks existing output
  and makes goldens ICU-version-fragile); a **trailing `ctx` arg** on every helper call (silently
  corrupts variadic helpers' args); **widening `Helper`** to `(args, ctx)` (breaks the whole public
  helper contract for one need already served by closure binding).
