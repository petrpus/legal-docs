import { z } from "zod";

/**
 * Shared payload schema fragments — reusable zod pieces so documents don't duplicate common shapes.
 * The first fragments cover the money / loan slices; more are extracted as documents need them.
 */
export const money = z.object({
  amount: z.number(),
  currency: z.string().length(3),
});

export const loan = z.object({
  principal: money,
  rate: z.number().optional(),
});

/** Party identification — reused across document payload schemas and the `partyHeader` Block. */
export const party = z.object({
  name: z.string(),
  kind: z.enum(["person", "company"]).optional(),
  idNumber: z.string().optional(),
  address: z.string().optional(),
});

export type Money = z.infer<typeof money>;
export type Loan = z.infer<typeof loan>;
export type Party = z.infer<typeof party>;
