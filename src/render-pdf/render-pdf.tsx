import { Document, Page, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import type { DocumentNode, DocumentTree } from "../core/document-tree";
import type { RichRun } from "../core/rich-text";
import { MAX_LEVEL } from "../core/engine";
import { defaultTheme, type Theme } from "./theme";

/**
 * The PDF Renderer: a visitor over the DocumentTree. The switch is exhaustive over the Core node
 * set, so adding a node kind is a compile error here until this renderer handles it.
 */
function nodeToElement(node: DocumentNode, key: number, theme: Theme): ReactElement {
  switch (node.kind) {
    case "title":
      return (
        <Text
          key={key}
          style={{ fontSize: theme.fontSize.title, marginBottom: theme.spacing.title }}
        >
          {node.text}
        </Text>
      );
    case "paragraph":
      return (
        <Text
          key={key}
          style={{ fontSize: theme.fontSize.paragraph, marginBottom: theme.spacing.paragraph }}
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
          {node.body.map((child, ci) => nodeToElement(child, ci, theme))}
        </View>
      );
    }
    case "numberedList":
      return listElement(node.items, key, theme, (i) => `${i + 1}.`);
    case "bulletList":
      return listElement(node.items, key, theme, () => "•");
    case "alphaList":
      return listElement(node.items, key, theme, (i) => `${String.fromCharCode(97 + i)}.`);
    default: {
      // Exhaustive over the Core node set: a new kind makes this assignment a compile error,
      // and this also guards untyped JS callers at runtime.
      const unhandled: never = node;
      throw new Error(`Unsupported node kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

function listElement(
  items: DocumentNode[][],
  key: number,
  theme: Theme,
  marker: (index: number) => string,
): ReactElement {
  return (
    <View key={key} style={{ marginLeft: theme.list.indent, marginBottom: theme.list.gap }}>
      {items.map((item, i) => (
        <View key={i} style={{ flexDirection: "row", marginBottom: theme.list.gap }}>
          <Text style={{ fontSize: theme.fontSize.paragraph, marginRight: theme.list.markerGap }}>
            {marker(i)}
          </Text>
          <View>{item.map((child, ci) => nodeToElement(child, ci, theme))}</View>
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
export function documentElement(tree: DocumentTree, theme: Theme = defaultTheme) {
  return createElement(
    Document,
    null,
    <Page size={theme.page.size} style={{ padding: theme.page.padding, color: theme.color.text }}>
      {tree.map((node, i) => nodeToElement(node, i, theme))}
    </Page>,
  );
}

export function renderTreeToBuffer(tree: DocumentTree, theme?: Theme): Promise<Buffer> {
  return renderToBuffer(documentElement(tree, theme));
}
