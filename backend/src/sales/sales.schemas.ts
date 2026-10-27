import { z } from 'zod';

/** Body shared by the portal (POST /api/sales) and the partner API (POST /api/partner/v1/sales). */
export const createSaleSchema = z
  .object({
    productId: z.number().int().positive(),
    amount: z.number().int().positive(),
    destination: z.string().trim().min(3).max(120),
  })
  .strict();

export type CreateSaleInput = z.infer<typeof createSaleSchema>;
