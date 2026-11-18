import { z } from 'zod';
import { validDate } from './finance';

export const id = z.uuid();
export const name = z.string().trim().min(1).max(80);
export const date = z.string().refine(validDate, 'Enter a valid date.');
export const month = z.string().regex(/^(19\d{2}|[2-9]\d{3})-(0[1-9]|1[0-2])$/);
export const minor = z.int();
export const nonnegative = minor.min(0);
export const theme = z.enum(['light', 'dark']);
export const empty = z.undefined();

export class UserError extends Error {}
