import { z } from 'zod';
import { date, id, minor, name } from '../../shared/schema';

export const goalInput = z.object({ id: id.optional(), name, target: minor.positive(), due: date.nullable() });
export const entryInput = z.object({ goalId: id, pairId: id.nullable(), amount: minor.refine(Boolean), date });
export type GoalEntry = z.infer<typeof entryInput> & { id: string };
export type Goal = { id: string; name: string; target: number; due: string | null; progress: number; entries: GoalEntry[] };
