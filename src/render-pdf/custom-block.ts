import type { ReactElement } from "react";
import type { Paragraph, Table } from "docx";
import type { ZodType } from "zod";
import type { Theme } from "./theme";

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
 * required; `html`/`docx` slots arrive with those renderers (Phases 4–5). An optional `schema`
 * validates `props` at render dispatch. A Custom block is a leaf — it renders its own complete layout.
 */
export interface CustomBlock {
  schema?: ZodType;
  pdf: PdfCustomBlock;
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
