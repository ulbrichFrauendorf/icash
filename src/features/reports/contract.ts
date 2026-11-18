import { z } from 'zod';
import { id, month } from '../../shared/schema';

export const reportInput = z.object({ month, accountId: id.optional(), period: z.enum(['month', 'year']).default('month') });
export type Comparison = { month: string; income: number; expense: number; net: number };
export type Report = Comparison & {
  start: string; end: string; covered: boolean; uncategorized: number; allocated: number; budgetActual: number;
  remaining: number; goalProgress: number; commitments: number;
  goals: { name: string; progress: number; target: number }[];
  recurring: { name: string; amount: number }[];
  categories: { id: string | null; name: string; amount: number; unusual: boolean; baseline: number | null; historyMonths: number }[];
  trend: Comparison[]; prior: Comparison; period: 'month' | 'year';
};
