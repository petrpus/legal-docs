import { LegalDocsError } from "../core/errors";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Font } from "@react-pdf/renderer";
import { DEFAULT_FONT_FAMILY } from "../theme";

/**
 * PDF fonts. react-pdf embeds its own font subset, and its built-in Helvetica (Standard-14, WinAnsi)
 * cannot render Czech/Latin-Extended diacritics — "Příliš žluťoučký kůň" comes out as "PYíliš…". So we
 * bundle a diacritics-safe serif (Liberation Serif, SIL OFL — `assets/fonts/`) and register it under
 * {@link DEFAULT_FONT_FAMILY}. Consumers can register their own via the re-exported {@link Font}.
 */

/** Locate the package root (holds `assets/`) from the module URL — works from both `src/` and bundled `dist/`. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8 && !existsSync(join(dir, "package.json")); i++) dir = dirname(dir);
  if (!existsSync(join(dir, "package.json"))) {
    throw new LegalDocsError("legal-docs: could not locate the package root to load the bundled PDF fonts");
  }
  return dir;
}

function fontFile(name: string): string {
  return join(packageRoot(), "assets", "fonts", name);
}

let registered = false;

/**
 * Register the bundled Liberation Serif (regular/bold/italic/bold-italic) under
 * {@link DEFAULT_FONT_FAMILY}. Idempotent; called automatically before every PDF render. A consumer
 * who overrides `theme.font.family` must register that family themselves via {@link Font}.
 */
export function registerBundledFonts(): void {
  if (registered) return;
  Font.register({
    family: DEFAULT_FONT_FAMILY,
    fonts: [
      { src: fontFile("LiberationSerif-Regular.ttf"), fontWeight: "normal", fontStyle: "normal" },
      { src: fontFile("LiberationSerif-Bold.ttf"), fontWeight: "bold", fontStyle: "normal" },
      { src: fontFile("LiberationSerif-Italic.ttf"), fontWeight: "normal", fontStyle: "italic" },
      { src: fontFile("LiberationSerif-BoldItalic.ttf"), fontWeight: "bold", fontStyle: "italic" },
    ],
  });
  registered = true; // set only after a successful register, so a throw stays retry-able
}

/** The shape of a loaded font source as react-pdf's `Font` registry exposes it. */
type RegisteredFontSource = { data?: { _glyphs?: Record<number, unknown> } | null };

/**
 * Drop fontkit's per-font glyph cache on every registered font.
 *
 * fontkit memoises `Glyph` objects on the loaded font, and pdfkit writes subset state into those
 * objects while embedding a document's font subset. react-pdf keeps each loaded font as a
 * process-wide singleton, so a `Glyph` first cached by one document is handed, subset id and all, to
 * the next document that needs the same character — whose own subset then maps it one slot off and
 * the character silently disappears from the page (a capital carrying an acute accent, `Í`/`Ý`,
 * reliably seeds it). Clearing the cache around a render keeps every document's subset
 * self-contained. The cache is a private field, hence the loose typing; if it is absent there is
 * nothing to clear.
 */
export function clearGlyphCaches(): void {
  const families = Font.getRegisteredFonts() as Record<string, { sources?: RegisteredFontSource[] }>;
  for (const family of Object.values(families)) {
    for (const source of family?.sources ?? []) {
      if (source.data?._glyphs) source.data._glyphs = {};
    }
  }
}
