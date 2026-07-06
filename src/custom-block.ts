import { LegalDocsError } from "./core/errors";
import type { ReactElement } from "react";
import type { Paragraph, Table } from "docx";
import type { ZodType } from "zod";
import type { DeepPartial, Theme } from "./theme";

/** Context a Custom block implementation receives (deliberately minimal; extensible later). */
export interface CustomBlockContext {
  theme: Theme;
}

/** The PDF implementation of a Custom block: bound props + context → a react-pdf element. */
export type PdfCustomBlock = (props: unknown, ctx: CustomBlockContext) => ReactElement;

/** The HTML implementation of a Custom block: bound props + context → an HTML string (inserted raw). */
export type HtmlCustomBlock = (props: unknown, ctx: CustomBlockContext) => string;

/** The DOCX implementation of a Custom block: bound props + context → block-level docx elements. */
export type DocxCustomBlock = (props: unknown, ctx: CustomBlockContext) => (Paragraph | Table)[];

/**
 * A Custom block: a code-side, renderer-native implementation per output format (ADR-0005). `pdf` is
 * required; `html`/`docx` are optional (a missing one triggers the Degradation contract). An optional
 * `schema` validates `props` at render dispatch. A Custom block is a leaf — it renders its own layout.
 */
/**
 * A Custom block's per-format implementations (ADR-0005). **All three are optional** — register only
 * the formats you render; a format with no implementation degrades per the {@link DegradationMode}
 * (so an HTML-only app needn't author a react-pdf `pdf` impl). Register at least one.
 */
export interface CustomBlock {
  schema?: ZodType;
  pdf?: PdfCustomBlock;
  html?: HtmlCustomBlock;
  docx?: DocxCustomBlock;
}

/** Code-side registry of Custom blocks, keyed by `component` name. Passed to renderDocument/validate. */
export type CustomBlockRegistry = Record<string, CustomBlock>;

/**
 * What happens when a registered Custom block lacks the target format's implementation (Degradation
 * contract, ADR-0005). `placeholder` (default) emits a visible, logged marker; `throw` fails hard.
 * Silent omission is never allowed.
 */
export type DegradationMode = "placeholder" | "throw";

/** A degradation event surfaced to a consumer-supplied {@link OnDegrade} sink. */
export interface DegradationEvent {
  component: string;
  format: "pdf" | "html" | "docx";
  /** The placeholder marker text (also what the renderer renders in `placeholder` mode). */
  marker: string;
}

/** A consumer sink for degradation events. When supplied, it replaces the default `console.warn`. */
export type OnDegrade = (event: DegradationEvent) => void;

/** Options shared by all three tree renderers (`renderTreeToPdf`/`Html`/`Docx`). */
export interface RenderTreeOptions {
  /** A partial theme, deep-merged over `defaultTheme` (override one token without re-spreading the rest). */
  theme?: DeepPartial<Theme>;
  customBlocks?: CustomBlockRegistry;
  degradation?: DegradationMode;
  onDegrade?: OnDegrade;
}

/**
 * Apply the Degradation contract for a missing-format Custom block: in `throw` mode fail hard; in
 * `placeholder` mode notify (the consumer's {@link OnDegrade} sink, or `console.warn` by default) and
 * return the marker for the renderer to render. Never silent.
 */
export function reportDegradation(
  component: string,
  format: DegradationEvent["format"],
  mode: DegradationMode,
  onDegrade?: OnDegrade,
): string {
  if (mode === "throw") {
    throw new LegalDocsError(
      `Custom block "${component}" cannot render in "${format}": no ${format} implementation (degradation=throw)`,
    );
  }
  if (mode === "placeholder") {
    const marker = `[unsupported block: ${component} in ${format}]`;
    if (onDegrade) onDegrade({ component, format, marker });
    else console.warn(marker);
    return marker;
  }
  const unsupported: never = mode;
  throw new LegalDocsError(`Unknown degradation mode: ${String(unsupported)}`);
}
