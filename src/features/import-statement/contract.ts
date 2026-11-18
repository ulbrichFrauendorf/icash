import { z } from 'zod';
import { id } from '../../shared/schema';

const column = z.int().min(0).max(127);
export const decodeInput = z.object({
  token: id,
  delimiter: z.enum([',', ';', '\t']),
  encoding: z.enum(['utf-8', 'windows-1252', 'utf-16le']),
  header: z.int().min(1).max(50),
});
export const mapping = z.object({
  delimiter: decodeInput.shape.delimiter, encoding: decodeInput.shape.encoding, header: decodeInput.shape.header,
  date: column, description: column, amount: column.optional(), debit: column.optional(), credit: column.optional(),
  balance: column.optional(), reference: column.optional(), dateFormat: z.enum(['ymd', 'dmy', 'mdy']),
  decimal: z.enum(['.', ',']), invert: z.boolean().default(false),
}).refine((value) => value.amount !== undefined ? value.debit === undefined && value.credit === undefined :
  value.debit !== undefined && value.credit !== undefined, 'Map either Amount or both Debit and Credit.')
  .refine((value) => {
    const columns = [value.date, value.description, value.amount, value.debit, value.credit, value.balance, value.reference]
      .filter((index) => index !== undefined);
    return columns.length === new Set(columns).size;
  }, 'Use a different column for each field.');
export const previewInput = z.object({ token: id, mapping });
export const commitInput = z.object({
  token: id, version: id, acceptRejected: z.boolean(),
}).strict();
export type Mapping = z.infer<typeof mapping>;
export type Candidate = { date: string; description: string; amount: number; balance: number | null; reference: string | null };
export type FilePreview = { token: string; fileName: string; delimiter: Mapping['delimiter']; encoding: Mapping['encoding']; header: number; headers: string[]; rows: string[][]; suggested: Partial<Mapping>; saved: Mapping | null };
export type RowPreview = {
  row: number; candidate?: Candidate; original: string[];
  state: 'accepted' | 'duplicate' | 'rejected' | 'skipped'; message: string;
};
export type ImportPreview = {
  version: string; counts: Record<RowPreview['state'], number>; debits: number; credits: number; net: number;
  rows: RowPreview[]; reconciliation: string | null;
};
export type ImportResult = { id: string; inserted: number; duplicate: number; rejected: number };
export type Batch = ImportResult & { account: string; file: string; createdAt: string; skipped: number };
export type AuditRow = { row: number; state: string; message: string; transactionId: string | null; original: string[] };
