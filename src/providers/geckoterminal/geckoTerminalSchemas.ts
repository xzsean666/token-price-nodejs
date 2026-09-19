import { z } from "zod";

const relationshipSchema = z.object({ data: z.object({ id: z.string(), type: z.string() }).nullable().optional() }).passthrough();

export const geckoPoolSchema = z.object({
  id: z.string(),
  type: z.literal("pool"),
  attributes: z.object({
    address: z.string().optional(),
    reserve_in_usd: z.union([z.string(), z.number()]).optional(),
    volume_usd: z.object({ h24: z.union([z.string(), z.number()]).optional() }).optional(),
  }).passthrough(),
  relationships: z.object({
    network: relationshipSchema,
    base_token: relationshipSchema,
    quote_token: relationshipSchema,
  }).passthrough(),
}).passthrough();

export const geckoTokenSchema = z.object({
  id: z.string(),
  type: z.literal("token"),
  attributes: z.object({
    address: z.string(),
    symbol: z.string().optional(),
    name: z.string().optional(),
  }).passthrough(),
}).passthrough();

export const geckoSearchSchema = z.object({
  data: z.array(geckoPoolSchema),
  included: z.array(geckoTokenSchema).optional(),
}).passthrough();

export const geckoOhlcvSchema = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(z.array(z.union([z.string(), z.number()])).min(6)),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export type GeckoPool = z.infer<typeof geckoPoolSchema>;
export type GeckoToken = z.infer<typeof geckoTokenSchema>;
