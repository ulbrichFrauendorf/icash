import { z } from 'zod';
import { date, id, minor } from '../../shared/schema';

export const treatment = z.enum(['expense', 'income', 'transfer']);
export const filters = z.object({
  start: date.optional(), end: date.optional(), accountId: id.optional(), categoryId: id.nullable().optional(),
  text: z.string().trim().max(200).default(''), merchant: z.string().trim().max(200).default(''),
  type: treatment.optional(), minimum: minor.optional(), maximum: minor.optional(),
  sort: z.enum(['newest', 'oldest', 'amount']).default('newest'),
  page: z.int().min(0).max(100000).default(0), scoped: z.enum(['budget', 'report']).optional(),
}).refine((filter) => !filter.start || !filter.end || filter.start <= filter.end, 'End date must follow start date.')
  .refine((filter) => filter.minimum === undefined || filter.maximum === undefined || filter.minimum <= filter.maximum,
    'Minimum cannot exceed maximum.');
export type Filters = z.input<typeof filters>;
export const transactionInput = z.object({
  id, categoryId: id.nullable(), treatment, merchant: z.string().trim().max(120),
  notes: z.string().max(4000), tags: z.string().trim().max(300),
  excludeBudget: z.boolean(), excludeReports: z.boolean(), confirmClassification: z.boolean().optional(),
  splits: z.array(z.object({ categoryId: id, amount: minor })).max(30),
});
export type EditTransaction = z.infer<typeof transactionInput>;
export type Transaction = Omit<EditTransaction, 'splits' | 'confirmClassification'> & {
  accountId: string; account: string; batchId: string; date: string; amount: number; description: string;
  balance: number | null; reference: string | null; category: string | null; classification: string;
  rule: string | null; pairId: string | null; hasSplits: boolean; contribution: number | null;
};
export type TransactionPage = { rows: Transaction[]; total: number; size: number };
export type TransactionDetail = Transaction & {
  splits: EditTransaction['splits']; original: string[]; sourceRow: number;
};
