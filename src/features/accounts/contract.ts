import { z } from 'zod';
import { date, id, name } from '../../shared/schema';

export const kind = z.enum(['current', 'savings', 'credit-card', 'other']);
export const saveAccountInput = z.object({ id: id.optional(), name, kind, archived: z.boolean().default(false) });
export const coverageInput = z.object({ accountId: id, start: date, end: date })
  .refine((value) => value.start <= value.end, 'Coverage start must come before end.');
export type Account = { id: string; name: string; kind: z.infer<typeof kind>; archived: number };
