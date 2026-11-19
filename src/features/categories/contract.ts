import { z } from 'zod';
import { id, name } from '../../shared/schema';

export const categoryKind = z.enum(['expense', 'income', 'transfer', 'savings']);
export const categoryFields = z.object({
  name,
  kind: categoryKind,
  colour: z.string().regex(/^#[0-9a-f]{6}$/i),
  icon: z.string().max(24).default(''),
  sort: z.int().min(-100000).max(100000).default(0),
  archived: z.boolean().default(false),
  excludeReports: z.boolean().default(false),
});
export const saveCategoryInput = categoryFields.extend({ id: id.optional(), parentId: id.nullable() });
export const deleteCategoryInput = z.object({ id, expectedRuleIds: z.array(id) });
export type CategoryDeletion = { ruleIds: string[] };
export type Category = z.infer<typeof categoryFields> & {
  id: string; parentId: string | null; templateKey: string | null; leaf: boolean;
};
