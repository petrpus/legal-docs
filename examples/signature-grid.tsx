import { Text, View } from "@react-pdf/renderer";
import { z } from "zod";
// In a consuming project, import this from the package instead: `from "@petrpus/legal-docs"`.
import type { CustomBlock } from "../src/index";

/**
 * A product-agnostic example **Custom block** (ADR-0005): a multi-column grid of signature cells —
 * a special layout the single-row core `signatures` node cannot express. A consumer registers it
 * code-side (`renderDocument({ customBlocks: { "signature-grid": signatureGrid } })`) and references
 * it from a template with `custom: { component: "signature-grid", props: { signatories, columns } }`.
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
};
