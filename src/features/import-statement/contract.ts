import { z } from 'zod';
import { id, name } from '../../shared/schema';
import { categoryChoice, type SuggestedCategory } from '../openai/contract';

export const statementLimit = 12 * 1024 * 1024;
export const selectImportInput = z.object({
  id,
  name: z.string().trim().max(255).regex(/^[^/\\:]+\.(csv|txt)$/i, 'Choose a CSV or TXT statement.'),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= statementLimit, 'Choose a statement up to 12 MiB.'),
}).strict();

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
export const importVersion = z.object({ token: id, version: id });
export const moderateCategoryInput = importVersion.extend({
  proposalId: id,
  action: z.enum(['edit', 'accept', 'delete']),
  edit: z.object({ name, group: name }).optional(),
});
export const importCategoryChanges = z.array(z.object({ row: z.int().positive(), choice: categoryChoice })).max(60000);
export const importRulesInput = importVersion.extend({ changes: importCategoryChanges });
export const commitInput = z.object({
  token: id, version: id, acceptRejected: z.boolean(),
  review: z.object({
    changes: importCategoryChanges,
    ruleKeys: z.array(z.string().max(1500)).max(60000),
  }).optional(),
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
  rows: RowPreview[]; reconciliation: string | null; review?: ImportReview; pendingCategories?: number;
};
export type ImportReviewRow = {
  row: number; description: string; date: string; amount: number; treatment: 'expense' | 'income';
  suggestion?: SuggestedCategory;
};
export type ImportReview = { rows: ImportReviewRow[]; suggested: number; notice?: string };
export type ImportResult = { id: string; inserted: number; duplicate: number; rejected: number; rulesSaved?: number };
export type Batch = ImportResult & { account: string; file: string; createdAt: string; skipped: number };
export type AuditRow = { row: number; state: string; message: string; transactionId: string | null; original: string[] };

export type CategoryProposal = {
  id: string; name: string; group: string; rows: number;
  status: 'pending' | 'accepted' | 'deleted';
};
export type ImportModeration = {
  token: string; version: string; fileName: string; proposals: CategoryProposal[];
};
export type ResumableImport = { file: FilePreview; mapping: Mapping; accountId: string; preview: ImportPreview };
export type ImportRule = { key: string; name: string; match: string; direction: 'debit' | 'credit';
  category: string; categoryId: string; kind: ImportReviewRow['treatment']; rows: number[]; };
