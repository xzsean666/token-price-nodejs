import { z } from "zod";

export const okxEnvelopeSchema = z.object({
  code: z.string(),
  msg: z.string().optional(),
  data: z.array(z.unknown()),
}).passthrough();

export const okxInstrumentSchema = z.object({
  instId: z.string(),
  instType: z.string(),
  state: z.string(),
}).passthrough();
