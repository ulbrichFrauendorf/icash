import { z } from 'zod';
import { id } from '../../shared/schema';

export const candidateInput = z.object({ id, days: z.int().min(0).max(14).default(3) });
export const pairInput = z.object({ first: id, second: id, days: z.int().min(0).max(14) });
export type TransferCandidate = { id: string; date: string; amount: number; description: string; account: string };
