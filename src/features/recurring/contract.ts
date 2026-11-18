import { z } from 'zod';
import { date, minor, name } from '../../shared/schema';

export const scheduleInput = z.object({
  fingerprint: z.string().max(600), name, amount: minor.refine(Boolean), cadence: z.enum(['weekly', 'monthly']),
  next: date, state: z.enum(['confirmed', 'dismissed']),
});
export type Schedule = Omit<z.infer<typeof scheduleInput>, 'state'> & {
  state: 'suggested' | 'confirmed'; evidence: { date: string; amount: number; description: string }[];
};
