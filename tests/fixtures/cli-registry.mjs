import { createElement } from "react";
import { Text } from "@react-pdf/renderer";
import { z } from "zod";

// Mirrors the registries scripts/render-samples.mjs builds inline — the CLI's --config convention.
const signatureGridSchema = z.object({
  signatories: z.array(z.object({ name: z.string(), role: z.string().optional() })),
  columns: z.number().int().positive().optional(),
});

export const schemas = {
  "greeting@1": z.object({ name: z.string(), loan: z.object({ principal: z.object({ amount: z.number(), currency: z.string() }) }) }),
  "terms@1": z.object({
    parties: z.array(z.object({ name: z.string(), role: z.string() })),
    hasGuarantor: z.boolean(),
  }),
};

export const derivations = {
  counterpartsCount: (p) => p.parties.length + 1,
  securityClause: (p) => (p.parties.length >= 3 ? "counterparts@v2" : "counterparts@v1"),
};

export const customBlocks = {
  "signature-grid": {
    schema: signatureGridSchema,
    pdf: (props) => {
      const { signatories } = signatureGridSchema.parse(props);
      return createElement(Text, null, signatories.map((s) => s.name).join(", "));
    },
  },
};
