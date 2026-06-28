import { Document, Page, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { cloneElement, createElement, type ReactElement } from "react";
import type { DocumentNode, DocumentTree } from "../core/document-tree";
import type { RichRun } from "../core/rich-text";
import { MAX_LEVEL } from "../core/engine";
import { validatePayload } from "../core/payload";
import { defaultTheme, type Theme } from "./theme";
import type { CustomBlockRegistry } from "./custom-block";

/**
 * The PDF Renderer: a visitor over the DocumentTree. The switch is exhaustive over the Core node
 * set, so adding a node kind is a compile error here until this renderer handles it.
 */
function nodeToElement(
  node: DocumentNode,
  key: number,
  theme: Theme,
  customBlocks: CustomBlockRegistry,
): ReactElement {
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
          {node.body.map((child, ci) => nodeToElement(child, ci, theme, customBlocks))}
        </View>
      );
    }
    case "numberedList":
      return listElement(node.items, key, theme, customBlocks, (i) => `${i + 1}.`);
    case "bulletList":
      return listElement(node.items, key, theme, customBlocks, () => "•");
    case "alphaList":
      return listElement(node.items, key, theme, customBlocks, (i) => `${String.fromCharCode(97 + i)}.`);
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
      return customElement(node, key, theme, customBlocks);
    default: {
      // Exhaustive over the Core node set: a new kind makes this assignment a compile error,
      // and this also guards untyped JS callers at runtime.
      const unhandled: never = node;
      throw new Error(`Unsupported node kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Dispatch a `custom` node to its registered Custom block. An unregistered component is a hard error
 * (a config/authoring bug). A declared props `schema` is validated before the implementation runs.
 * (The missing-`pdf` branch is a runtime guard for untyped callers; the Degradation contract for
 * missing formats arrives in a follow-up slice.)
 */
function customElement(
  node: Extract<DocumentNode, { kind: "custom" }>,
  key: number,
  theme: Theme,
  customBlocks: CustomBlockRegistry,
): ReactElement {
  const block = customBlocks[node.component];
  if (!block) throw new Error(`Custom block "${node.component}" is not registered`);
  if (typeof block.pdf !== "function") {
    throw new Error(`Custom block "${node.component}" has no pdf implementation`);
  }
  let props = node.props;
  if (block.schema) {
    try {
      props = validatePayload(block.schema, node.props);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Custom block "${node.component}" received invalid props: ${reason}`, { cause });
    }
  }
  // The block owns its layout (ADR-0005); inject only a key — no wrapper — so it controls its own
  // paging/break behaviour rather than us imposing keep-together.
  return cloneElement(block.pdf(props, { theme }), { key });
}

function listElement(
  items: DocumentNode[][],
  key: number,
  theme: Theme,
  customBlocks: CustomBlockRegistry,
  marker: (index: number) => string,
): ReactElement {
  return (
    <View key={key} style={{ marginLeft: theme.list.indent, marginBottom: theme.list.gap }}>
      {items.map((item, i) => (
        <View key={i} style={{ flexDirection: "row", marginBottom: theme.list.gap }}>
          <Text style={{ fontSize: theme.fontSize.paragraph, marginRight: theme.list.markerGap }}>
            {marker(i)}
          </Text>
          <View>{item.map((child, ci) => nodeToElement(child, ci, theme, customBlocks))}</View>
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
) {
  return createElement(
    Document,
    null,
    <Page size={theme.page.size} style={{ padding: theme.page.padding, color: theme.color.text }}>
      {tree.map((node, i) => nodeToElement(node, i, theme, customBlocks))}
    </Page>,
  );
}

export function renderTreeToBuffer(
  tree: DocumentTree,
  theme?: Theme,
  customBlocks?: CustomBlockRegistry,
): Promise<Buffer> {
  return renderToBuffer(documentElement(tree, theme, customBlocks));
}
