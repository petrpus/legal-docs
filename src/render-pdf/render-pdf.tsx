import { LegalDocsError } from "../core/errors";
import { Document, Page, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { cloneElement, createElement, type ReactElement } from "react";
import type { DocumentBody, DocumentNode, DocumentTree, PageFurniture } from "../core/document-tree";
import { asDocumentTree, PAGE_NUMBER_SENTINEL, PAGE_TOTAL_SENTINEL } from "../core/document-tree";
import type { RichRun } from "../core/rich-text";
import { MAX_LEVEL } from "../core/engine";
import { defaultTheme, mergeTheme, type Theme } from "../theme";
import { effectivePage } from "../core/page";
import { registerBundledFonts } from "./fonts";
import { dispatchCustomBlock } from "../custom-block";
import type { CustomBlockRegistry, DegradationMode, OnDegrade, RenderTreeOptions } from "../custom-block";

/** Render-time Custom-block context threaded through the visitor. */
interface CustomCtx {
  blocks: CustomBlockRegistry;
  degradation: DegradationMode;
  onDegrade?: OnDegrade;
}

/** react-pdf indent style for a title/paragraph, emitting a prop only when non-zero (ADR-0008). */
function indentStyle(firstLine: number, left: number): { textIndent?: number; marginLeft?: number } {
  return {
    ...(firstLine ? { textIndent: firstLine } : {}),
    ...(left ? { marginLeft: left } : {}),
  };
}

/**
 * The PDF Renderer: a visitor over the DocumentTree. The switch is exhaustive over the Core node
 * set, so adding a node kind is a compile error here until this renderer handles it.
 */
function nodeToElement(
  node: DocumentNode,
  key: number,
  theme: Theme,
  cx: CustomCtx,
): ReactElement {
  switch (node.kind) {
    case "title":
      return (
        <Text
          key={key}
          style={{
            fontSize: theme.fontSize.title,
            marginBottom: theme.spacing.title,
            textAlign: node.align ?? theme.align.title,
            // Titles have no Theme indent default (0); only a per-block override indents them.
            ...indentStyle(node.indent?.firstLine ?? 0, node.indent?.left ?? 0),
          }}
        >
          {node.text}
        </Text>
      );
    case "paragraph":
      return (
        <Text
          key={key}
          style={{
            fontSize: theme.fontSize.paragraph,
            marginBottom: theme.spacing.paragraph,
            textAlign: node.align ?? theme.align.paragraph,
            ...indentStyle(node.indent?.firstLine ?? theme.indent.firstLine, node.indent?.left ?? theme.indent.block),
          }}
        >
          {node.text}
        </Text>
      );
    case "richText":
      return (
        <View key={key}>
          {node.value.blocks.map((paragraph, pi) => (
            <Text
              key={pi}
              style={{ fontSize: theme.fontSize.paragraph, marginBottom: theme.spacing.paragraph }}
            >
              {paragraph.runs.map((run, ri) => (
                <Text key={ri} style={runStyle(run)}>
                  {run.text}
                </Text>
              ))}
            </Text>
          ))}
        </View>
      );
    case "article": {
      const size =
        theme.article.headingFontSize[Math.min(node.level, MAX_LEVEL) - 1] ??
        theme.article.headingFontSize[0];
      return (
        <View
          key={key}
          style={{
            // Per-node indent only; DOM nesting accumulates it across levels.
            marginLeft: node.level === 1 ? 0 : theme.article.indentPerLevel,
            marginBottom: theme.article.gap,
          }}
        >
          <Text
            style={{ fontSize: size, fontWeight: "bold", marginBottom: theme.spacing.paragraph }}
          >
            {node.heading === undefined ? node.no : `${node.no} ${node.heading}`}
          </Text>
          {node.body.map((child, ci) => nodeToElement(child, ci, theme, cx))}
        </View>
      );
    }
    case "numberedList":
      return listElement(node.items, key, theme, cx, (i) => `${i + 1}.`);
    case "bulletList":
      return listElement(node.items, key, theme, cx, () => "•");
    case "alphaList":
      return listElement(node.items, key, theme, cx, (i) => `${String.fromCharCode(97 + i)}.`);
    case "partyHeader":
      return (
        <View key={key} style={{ marginBottom: theme.partyHeader.gap }}>
          <Text style={{ fontSize: theme.partyHeader.roleFontSize, fontWeight: "bold" }}>
            {node.roleLabel}
          </Text>
          <Text style={{ fontSize: theme.fontSize.paragraph }}>{node.party.name}</Text>
          {node.party.idNumber !== undefined ? (
            <Text style={{ fontSize: theme.fontSize.paragraph }}>{node.party.idNumber}</Text>
          ) : null}
          {node.party.address !== undefined ? (
            <Text style={{ fontSize: theme.fontSize.paragraph }}>{node.party.address}</Text>
          ) : null}
        </View>
      );
    case "keyValueTable":
      return (
        <View
          key={key}
          style={{
            marginBottom: theme.spacing.paragraph,
            borderTopWidth: 1,
            borderColor: theme.table.borderColor,
          }}
        >
          {node.rows.map((row, i) => (
            <View
              key={i}
              style={{
                flexDirection: "row",
                borderBottomWidth: 1,
                borderColor: theme.table.borderColor,
              }}
            >
              <Text
                style={{
                  width: theme.table.labelWidth,
                  padding: theme.table.cellPadding,
                  fontSize: theme.table.fontSize,
                  fontWeight: "bold",
                }}
              >
                {row.label}
              </Text>
              <Text
                style={{ flex: 1, padding: theme.table.cellPadding, fontSize: theme.table.fontSize }}
              >
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      );
    case "signatures":
      return (
        <View key={key} style={{ flexDirection: "row", marginTop: theme.signatures.gap }}>
          {node.places.map((place, i) => (
            <View key={i} style={{ flex: 1, marginRight: theme.signatures.columnGap }}>
              <View
                style={{
                  marginTop: theme.signatures.lineSpace,
                  borderTopWidth: theme.signatures.lineWidth,
                  borderColor: theme.signatures.lineColor,
                  marginBottom: 4,
                }}
              />
              <Text style={{ fontSize: theme.signatures.fontSize }}>{place.name}</Text>
              {place.role !== undefined ? (
                <Text style={{ fontSize: theme.signatures.fontSize, color: theme.signatures.roleColor }}>
                  {place.role}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      );
    case "custom":
      return customElement(node, key, theme, cx);
    default: {
      // Exhaustive over the Core node set: a new kind makes this assignment a compile error,
      // and this also guards untyped JS callers at runtime.
      const unhandled: never = node;
      throw new LegalDocsError(`Unsupported node kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Dispatch a `custom` node to its registered Custom block. An unregistered component is a hard error
 * (a config/authoring bug). A block missing this format's implementation goes through the Degradation
 * contract. A declared props `schema` is validated before the implementation runs.
 */
function customElement(
  node: Extract<DocumentNode, { kind: "custom" }>,
  key: number,
  theme: Theme,
  cx: CustomCtx,
): ReactElement {
  const result = dispatchCustomBlock(node, "pdf", {
    blocks: cx.blocks,
    theme,
    degradation: cx.degradation,
    onDegrade: cx.onDegrade,
  });
  // Degradation marker policy (see dispatchCustomBlock): plain body text in the default paragraph style.
  if ("marker" in result) {
    return (
      <Text key={key} style={{ fontSize: theme.fontSize.paragraph, color: theme.color.text }}>
        {result.marker}
      </Text>
    );
  }
  // The block owns its layout (ADR-0005); inject only a key — no wrapper — so it controls its own
  // paging/break behaviour rather than us imposing keep-together.
  return cloneElement(result.rendered, { key });
}

function listElement(
  items: DocumentNode[][],
  key: number,
  theme: Theme,
  cx: CustomCtx,
  marker: (index: number) => string,
): ReactElement {
  return (
    <View key={key} style={{ marginLeft: theme.list.indent, marginBottom: theme.list.gap }}>
      {items.map((item, i) => (
        <View key={i} style={{ flexDirection: "row", marginBottom: theme.list.gap }}>
          <Text style={{ fontSize: theme.fontSize.paragraph, marginRight: theme.list.markerGap }}>
            {marker(i)}
          </Text>
          <View>{item.map((child, ci) => nodeToElement(child, ci, theme, cx))}</View>
        </View>
      ))}
    </View>
  );
}

function runStyle(run: RichRun): { fontWeight?: "bold"; fontStyle?: "italic" } {
  return {
    ...(run.marks?.includes("bold") ? { fontWeight: "bold" } : {}),
    ...(run.marks?.includes("italic") ? { fontStyle: "italic" } : {}),
  };
}

/**
 * Build the root Document element via `createElement` (not JSX) so its `DocumentProps` type is
 * preserved for `renderToBuffer` / `renderToStream` — JSX would widen it to `ReactElement<unknown>`.
 */
export function documentElement(
  tree: DocumentTree,
  theme: Theme = defaultTheme,
  customBlocks: CustomBlockRegistry = {},
  degradation: DegradationMode = "placeholder",
  onDegrade?: OnDegrade,
) {
  const cx: CustomCtx = { blocks: customBlocks, degradation, onDegrade };
  return createElement(
    Document,
    null,
    // fontFamily on the Page cascades to all Text (react-pdf resolves bold/italic within the family).
    <Page {...effectivePage(theme, tree.page)} style={{ padding: theme.page.padding, color: theme.color.text, fontFamily: theme.font.family }}>
      {tree.header ? furnitureElement(tree.header, "header", theme) : null}
      {tree.body.map((node, i) => nodeToElement(node, i, theme, cx))}
      {tree.footer ? furnitureElement(tree.footer, "footer", theme) : null}
    </Page>,
  );
}

/**
 * A page header/footer: a `fixed` (repeats on every page), absolutely-positioned three-column row.
 * Each slot's page-number sentinels are substituted per page via react-pdf's `render` callback, which
 * is the only place `pageNumber`/`totalPages` are known.
 */
function furnitureElement(furniture: PageFurniture, kind: "header" | "footer", theme: Theme): ReactElement {
  const style = kind === "header" ? theme.header : theme.footer;
  const edge = kind === "header" ? { top: style.margin } : { bottom: style.margin };
  const fill =
    (slot: string) =>
    ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }): string =>
      slot.split(PAGE_NUMBER_SENTINEL).join(String(pageNumber)).split(PAGE_TOTAL_SENTINEL).join(String(totalPages));
  const column = { flexGrow: 1, flexBasis: 0 } as const;
  return (
    <View
      key={kind}
      fixed
      style={{
        position: "absolute",
        left: theme.page.padding,
        right: theme.page.padding,
        ...edge,
        flexDirection: "row",
        fontSize: style.fontSize,
        color: style.color,
      }}
    >
      <Text style={{ ...column, textAlign: "left" }} render={fill(furniture.left ?? "")} />
      <Text style={{ ...column, textAlign: "center" }} render={fill(furniture.center ?? "")} />
      <Text style={{ ...column, textAlign: "right" }} render={fill(furniture.right ?? "")} />
    </View>
  );
}

export function renderTreeToPdf(input: DocumentTree | DocumentBody, options: RenderTreeOptions = {}): Promise<Buffer> {
  // Register the bundled diacritics-safe font before rendering (idempotent). A consumer who sets a
  // different `theme.font.family` registers that family themselves via the re-exported `Font`.
  registerBundledFonts();
  const theme = mergeTheme(options.theme);
  return renderToBuffer(documentElement(asDocumentTree(input), theme, options.customBlocks, options.degradation, options.onDegrade));
}
