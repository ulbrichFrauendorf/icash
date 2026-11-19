import { z } from 'zod';
import { id, month, nonnegative } from '../../shared/schema';

export const monthInput = z.object({ month });
export const allocationInput = monthInput.extend({ categoryId: id, amount: nonnegative.nullable(), rollover: z.boolean() });
export const defaultInput = allocationInput.extend({ cadence: z.enum(['weekly', 'monthly', 'annual']) });
export const copyInput = monthInput.extend({ from: month });
export const closeInput = monthInput.extend({ closed: z.boolean() });
export type BudgetRow = {
  categoryId: string | null; name: string; parent: string | null; leaf: boolean; archived: boolean;
  allocated: number | null; rollover: number; carryForward: boolean; actual: number; remaining: number | null; variance: number | null; usage: number | null;
};
export type Budget = {
  month: string; start: string; end: string; rows: BudgetRow[]; allocated: number; rollover: number; actual: number; remaining: number;
  closed: boolean; delta: number | null; revision: number | null; changed: boolean;
};
export type Recommendation = {
  categoryId: string; name: string; amount: number | null; average: number | null;
  minimum: number | null; maximum: number | null; trend: number | null;
};
export type Recommendations = { months: string[]; rows: Recommendation[] };
