import type { ReactElement } from "react";
import type { ZodType } from "zod";
import type { Theme } from "./theme";

/** Context a Custom block implementation receives (deliberately minimal; extensible later). */
export interface CustomBlockContext {
  theme: Theme;
}

/** The PDF implementation of a Custom block: bound props + context → a react-pdf element. */
export type PdfCustomBlock = (props: unknown, ctx: CustomBlockContext) => ReactElement;

/**
 * A Custom block: a code-side, renderer-native implementation per output format (ADR-0005). `pdf` is
 * required; `html`/`docx` slots arrive with those renderers (Phases 4–5). An optional `schema`
 * validates `props` at render dispatch. A Custom block is a leaf — it renders its own complete layout.
 */
export interface CustomBlock {
  schema?: ZodType;
  pdf: PdfCustomBlock;
  /** Phase 4 (HTML renderer). */
  html?: unknown;
  /** Phase 5 (DOCX renderer). */
  docx?: unknown;
}

/** Code-side registry of Custom blocks, keyed by `component` name. Passed to renderDocument/validate. */
export type CustomBlockRegistry = Record<string, CustomBlock>;
