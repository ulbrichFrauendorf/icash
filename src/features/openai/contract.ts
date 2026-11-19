import { z } from 'zod';
import { id } from '../../shared/schema';

export const model = 'gpt-4.1-mini';
export const openAiKeyInput = z.object({ key: z.string().trim().regex(/^sk-[A-Za-z0-9_-]{12,509}$/, 'Enter a valid OpenAI API key.') }).strict();
export const categoryChoice = z.union([id, z.literal('suggested'), z.literal('')]);
export type CategoryChoice = z.infer<typeof categoryChoice>;
export const applyAiRulesInput = z.object({
  token: id,
  selected: z.array(z.object({ index: z.int().min(0).max(23), choice: categoryChoice })).min(1).max(24),
  applyToImported: z.boolean(),
}).strict();

export type AiStatus = { connected: boolean };
export type SuggestedCategory = {
  id: string | null;
  name: string;
  label: string;
  kind: 'expense' | 'income';
};
export type AiClassification = { token: string; category: SuggestedCategory; reason: string; ruleId?: string };
export type AiRule = {
  index: number;
  name: string;
  match: string;
  operator: 'contains';
  direction: 'debit' | 'credit';
  samples: number;
  category: SuggestedCategory;
  reason: string;
};
export type AiRules = { token: string; rules: AiRule[] };
