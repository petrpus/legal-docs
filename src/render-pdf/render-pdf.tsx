import { Document, Page, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import type { DocumentNode, DocumentTree } from "../core/document-tree";
import type { RichRun } from "../core/rich-text";
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
    default: {
      // Exhaustive over the Core node set: a new kind makes this assignment a compile error,
      // and this also guards untyped JS callers at runtime.
      const unhandled: never = node;
      throw new Error(`Unsupported node kind: ${JSON.stringify(unhandled)}`);
    }
  }
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
