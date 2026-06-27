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

export type Money = z.infer<typeof money>;
export type Loan = z.infer<typeof loan>;
