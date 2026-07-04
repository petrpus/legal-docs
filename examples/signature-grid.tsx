import { Text, View } from "@react-pdf/renderer";
import { BorderStyle, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { z } from "zod";
// In a consuming project, import these from the package instead: `from "@petrpus/legal-docs"`.
import { escapeHtml, eighths, halfPoints, twips, type CustomBlock } from "../src/index";

/**
 * A product-agnostic example **Custom block** (ADR-0005): a multi-column grid of signature cells —
 * a special layout the single-row core `signatures` node cannot express. A consumer registers it
 * code-side (`renderDocument({ customBlocks: { "signature-grid": signatureGrid } })`) and references
 * it from a template with `custom: { component: "signature-grid", props: { signatories, columns } }`.
 *
 * NOTE: `examples/demo/vite.config.ts` inlines an equivalent of this block (createElement instead of
 * JSX) so the demo server can register it — keep the two in sync.
 */
export const signatureGridSchema = z.object({
  signatories: z.array(z.object({ name: z.string(), role: z.string().optional() })),
  columns: z.number().int().positive().optional(),
});

export const signatureGrid: CustomBlock = {
  schema: signatureGridSchema,
  pdf: (props, { theme }) => {
    // Re-parse to narrow the `unknown` props into typed values without a cast (the dispatch already
    // validated them against this same schema, so this never throws here).
    const { signatories, columns = 2 } = signatureGridSchema.parse(props);
    const cellWidth = `${100 / columns}%`;
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {signatories.map((s, i) => (
          <View key={i} style={{ width: cellWidth, paddingRight: 12, marginBottom: 16 }}>
            <View
              style={{ marginTop: 28, borderTopWidth: 1, borderColor: theme.color.text, marginBottom: 4 }}
            />
            <Text style={{ fontSize: theme.fontSize.paragraph }}>{s.name}</Text>
            {s.role !== undefined ? (
              <Text style={{ fontSize: theme.signatures.fontSize, color: theme.signatures.roleColor }}>
                {s.role}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    );
  },
  html: (props, { theme }) => {
    const { signatories, columns = 2 } = signatureGridSchema.parse(props);
    const cellWidth = `${100 / columns}%`;
    const line = `border-top:${theme.signatures.lineWidth}px solid ${theme.signatures.lineColor};margin-top:${theme.signatures.lineSpace}px;margin-bottom:4px;`;
    // The block owns its markup, but must escape its own data — it builds HTML from untrusted strings.
    const cells = signatories
      .map((s) => {
        const role =
          s.role !== undefined
            ? `<div style="font-size:${theme.signatures.fontSize}px;color:${theme.signatures.roleColor}">${escapeHtml(s.role)}</div>`
            : "";
        return `<div class="sig-cell" style="width:${cellWidth};padding-right:12px;margin-bottom:16px;box-sizing:border-box"><div class="sig-cell__line" style="${line}"></div><div>${escapeHtml(s.name)}</div>${role}</div>`;
      })
      .join("");
    return `<div class="sig-grid" style="display:flex;flex-wrap:wrap">${cells}</div>`;
  },
  docx: (props, { theme }) => {
    const { signatories, columns = 2 } = signatureGridSchema.parse(props);
    const cell = (s: { name: string; role?: string }): TableCell => {
      const children = [
        new Paragraph({
          border: { top: { style: BorderStyle.SINGLE, size: eighths(theme.signatures.lineWidth), color: theme.signatures.lineColor.replace(/^#/, "") } },
          spacing: { before: twips(theme.signatures.lineSpace) },
        }),
        // Name at the signatures font size (matching the core `signatures` node's DOCX convention).
        new Paragraph({ children: [new TextRun({ text: s.name, size: halfPoints(theme.signatures.fontSize) })] }),
      ];
      if (s.role !== undefined) {
        children.push(
          new Paragraph({ children: [new TextRun({ text: s.role, size: halfPoints(theme.signatures.fontSize), color: theme.signatures.roleColor.replace(/^#/, "") })] }),
        );
      }
      return new TableCell({ children });
    };
    const rows: TableRow[] = [];
    for (let i = 0; i < signatories.length; i += columns) {
      rows.push(new TableRow({ children: signatories.slice(i, i + columns).map(cell) }));
    }
    const none = { style: BorderStyle.NONE, size: 0, color: "auto" };
    return [
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
        rows,
      }),
    ];
  },
};
