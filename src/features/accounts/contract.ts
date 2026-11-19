import { z } from 'zod';
import { id, name } from '../../shared/schema';

export const kind = z.enum(['current', 'savings', 'credit-card', 'other']);
export const saveAccountInput = z.object({ id: id.optional(), name, kind, archived: z.boolean().default(false) });
export type Account = { id: string; name: string; kind: z.infer<typeof kind>; archived: number };
