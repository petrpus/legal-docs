# Browser-safe demo entry & public doc-site scope

The generated HTML doc site (`docs/*.html`, `scripts/build-docs-site.mjs`) started as a straight
render of every markdown doc in the repo — README, ADRs, `docs/PLAN.md`, `CONTRIBUTING.md`, recipes,
the demo/action READMEs — plus a static Artifact preview. Once the user tried it, two gaps showed:
the site read as internal design history rather than an introduction for a newcomer, and it had no way
to *show* the library working short of reading prose or running the full Node demo server. This ADR
covers both: what the public site includes, and how a genuinely interactive demo can run on a static
site (GitHub Pages) with no server.

## Decision

**The public site is an introduction + developer reference + live demo, not the design archive.** The
11 ADRs, `docs/PLAN.md`, and `CONTRIBUTING.md` are removed from `scripts/build-docs-site.mjs`'s `PAGES`
manifest. They are not deleted — they stay in the repo, and `resolveHref()`'s existing GitHub-blob
fallback means any in-repo markdown link to one of them (e.g. `AUTHORING.md` referencing an ADR)
resolves to a `github.com/.../blob/main/...` URL automatically once the target is no longer registered
in `PAGES`, with no per-link change needed. `assertManifestComplete()`'s directory scan was narrowed to
stop expecting `docs/adr/*.md` as site pages, and `docs/PLAN.md`/`CONTRIBUTING.md` were added to its
`EXCLUDED` set (present on disk, deliberately unregistered) so the build-time completeness check keeps
protecting against a *different* new doc being silently dropped, without protecting these three.

**The live demo renders entirely client-side — no server, no PDF/DOCX.** A static GitHub Pages site
cannot run the Node-only PDF/DOCX renderers or read a file-based catalog, so the demo is scoped to what
a browser genuinely can do: bind a payload against a Template and render it with the HTML renderer.
`docs/live-demo.html` is a hand-authored page (not markdown-rendered — `scripts/build-docs-site.mjs`
gained a `raw: true` page kind that passes a source file through verbatim) with a JSON payload editor
and an `<iframe sandbox="">` preview, dynamically importing a new bundle: `docs/assets/browser-demo.js`,
built from a new entry `src/browser.ts` by a second `tsup.config.ts` config (`platform: "browser"`,
`noExternal: [/.*/]` — a static site can't resolve bare npm imports, so everything used is bundled in).

**`src/browser.ts` is a curated subset, not the full public API.** It excludes, by construction:
`FileCatalogStore` (`node:fs`/`node:path`), the Snapshot audit trail (`node:crypto`, used by
`buildSnapshot`), and both non-HTML renderers (`@react-pdf/renderer`, `docx`). Reaching this required
one small upstream fix: `Catalog.fromDir`'s import of `FileCatalogStore` was eager (top-level), so
merely importing the `Catalog` class — even to call `Catalog.fromStore` — pulled `node:fs` into any
bundle. It is now a dynamic `import()` inside `fromDir` only, a behavior-preserving change (confirmed by
the full test suite and a live CLI smoke run). Beyond that fix, `src/browser.ts` deliberately does not
import the `Catalog` class at all: esbuild still code-splits a dynamically-imported module out as a
separately-emitted, reachable chunk (verified — it appeared in an early build of this bundle, ~100KB,
unused but shipped), so a browser build that never calls `Catalog.fromDir` is cleaner working directly
against a bare `CatalogStore` (in practice `MemoryCatalogStore`, seeded in-memory).

**Template/Clause resolution is shared, not duplicated.** The first draft of `src/browser.ts`
reimplemented `Catalog.getTemplate`/`getClause`'s logic (variant composition, `@latest` resolution)
inline, kept in sync only by a comment — a real drift risk flagged in review. `src/catalog/resolve.ts`
now holds `resolveTemplate`/`resolveClause` (pure functions over `CatalogStore`, no `FileCatalogStore`
dependency), and both `Catalog` and `src/browser.ts` call it — one implementation, exercised by two test
suites (`tests/from-store.test.ts` over `FileCatalogStore`, `tests/browser.test.ts` over
`MemoryCatalogStore`) from different angles.

**The Snapshot is out of scope for the demo, not approximated.** `renderHtmlInBrowser` (the demo's
render entry point) mirrors `renderDocument({ format: "html" })`'s pipeline — validate, Resolve phase,
`assembleDocument`, `renderTreeToHtml` — but stops short of `buildSnapshot`, which needs `node:crypto`.
This is a real, documented gap (no audit Snapshot from the browser path), not silently patched over with
a browser-`crypto` polyfill or a fake id; a consumer needing a Snapshot uses the real Node-side facade.

## Consequences

- Regression protection is two-layered, mirroring the CLI's existing pattern (Wave 5 #1): a pre-build
  vitest suite (`tests/browser.test.ts`) exercises `src/browser.ts`'s actual logic, and a post-build CI
  step greps the built `docs/assets/browser-demo.js` for any `"node:` import specifier — a defense-in-depth
  backstop, since `tsup`'s `platform: "browser"` already fails the build outright on an unresolvable
  Node built-in.
- `npm run docs:build` now runs `npm run build` first, so `docs/assets/browser-demo.js` and the CLI/index
  builds all stay in lockstep with one command; the CI drift-check (`docs:build && git diff --exit-code
  -- docs/`) covers the bundle the same way it already covered the generated HTML pages.
- Alternatives rejected: **keeping ADRs/PLAN/CONTRIBUTING on the site** (the user's own read was that it
  buried the introduction and demo under design history — a newcomer's first stop should not be an
  ADR index); **a server-rendered "live" demo** (defeats "no server" for a GitHub Pages deploy, and
  duplicates `examples/demo/`'s existing deploy-ready Node server, which stays the full-featured PDF/
  DOCX/editing demo, linked from the site as "Full demo (server)"); **polyfilling Node built-ins for the
  browser bundle** (adds real bundle weight and a maintenance surface for a demo that doesn't need
  Snapshot/file-catalog capability at all).
