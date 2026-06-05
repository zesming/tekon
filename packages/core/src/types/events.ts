import { z } from 'zod';

export const runtimeEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
});
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
