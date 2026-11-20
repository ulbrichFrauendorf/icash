import { z } from 'zod';
import { id, minor, name } from '../../shared/schema';

export const conditions = z.object({
  field: z.enum(['description', 'merchant']).default('description'),
  operator: z.enum(['contains', 'equals', 'startsWith']).default('contains'),
  text: z.string().trim().min(1).max(200).optional(),
  direction: z.enum(['debit', 'credit']).optional(),
  accountId: id.optional(),
  minimum: minor.min(0).optional(),
  maximum: minor.min(0).optional(),
}).refine((rule) => Boolean(rule.text || rule.direction || rule.accountId ||
  rule.minimum !== undefined || rule.maximum !== undefined), 'Add at least one condition.')
  .refine((rule) => rule.minimum === undefined || rule.maximum === undefined ||
    rule.minimum <= rule.maximum, 'Minimum cannot exceed maximum.');
export const saveRuleInput = z.object({
  id: id.optional(), name, categoryId: id, conditions, priority: z.int().min(0).max(9999), enabled: z.boolean(),
});
export const merchantInput = z.object({ merchant: name, direction: z.enum(['debit', 'credit']), categoryId: id });
export type Rule = Omit<z.infer<typeof saveRuleInput>, 'id'> & { id: string; source: 'user' | 'default' };
export const rulePreviewOptions = z.object({ manualRuleId: id.optional() });
export const rulePreview = z.object({
  changes: z.int().min(0), protected: z.int().min(0), conflicts: z.int().min(0),
  sample: z.array(z.object({ id, description: z.string().max(500), from: id.nullable(), to: id.nullable() })).max(100),
  ...rulePreviewOptions.shape,
});
export type RulePreview = z.infer<typeof rulePreview>;
