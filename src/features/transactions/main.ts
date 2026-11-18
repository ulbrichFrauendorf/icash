import type { z } from 'zod';
import type { Db } from '../../platform/main/database';
import { cents } from '../../shared/finance';
import { UserError } from '../../shared/schema';
import { categories } from '../categories/main';
import type { EditTransaction, filters, Transaction, TransactionDetail, TransactionPage } from './contract';

const pageSize = 50;
const projection = `SELECT t.id,t.account_id AS accountId,t.batch_id AS batchId,a.name AS account,t.date,t.amount,t.description,
  t.balance,t.reference,t.merchant,t.notes,t.tags,t.treatment,t.category_id AS categoryId,c.name AS category,
  t.classification,r.name AS rule,tl.pair_id AS pairId,t.exclude_budget AS excludeBudget,t.exclude_reports AS excludeReports,
  EXISTS(SELECT 1 FROM splits WHERE transaction_id=t.id) AS hasSplits`;
const joins = `FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id
  LEFT JOIN rules r ON r.id=t.rule_id LEFT JOIN transfer_legs tl ON tl.transaction_id=t.id`;

function uiRow(row: Transaction): Transaction {
  return { ...row, excludeBudget: Boolean(row.excludeBudget), excludeReports: Boolean(row.excludeReports), hasSplits: Boolean(row.hasSplits) };
}

export function listTransactions(db: Db, input: z.infer<typeof filters>, all: true): Transaction[];
export function listTransactions(db: Db, input: z.infer<typeof filters>, all?: false): TransactionPage;
export function listTransactions(db: Db, input: z.infer<typeof filters>, all = false): TransactionPage | Transaction[] {
  const clauses: string[] = [];
  const bind: Record<string, string | number> = {};
  const add = (field: string, sql: string, value: string | number | undefined) => {
    if (value === undefined || value === '') return;
    clauses.push(sql);
    bind[field] = value;
  };
  add('start', 't.date>=@start', input.start);
  add('end', 't.date<=@end', input.end);
  add('accountId', 't.account_id=@accountId', input.accountId);
  add('type', 't.treatment=@type', input.type);
  add('minimum', 't.amount>=@minimum', input.minimum);
  add('maximum', 't.amount<=@maximum', input.maximum);
  add('merchant', "instr(lower(t.merchant),lower(@merchant))>0", input.merchant);
  if (input.text.length >= 3) {
    add('text', 't.rowid IN (SELECT rowid FROM transaction_search WHERE transaction_search MATCH @text)',
      '"' + input.text.replaceAll('"', '""') + '"');
  } else {
    add('text', "instr(lower(t.description || ' ' || t.merchant || ' ' || t.notes || ' ' || t.tags),lower(@text))>0", input.text);
  }
  const directReport = input.scoped === 'report'
    ? ' AND coalesce(c.exclude_reports,0)=0 AND NOT EXISTS(SELECT 1 FROM categories p WHERE p.id=c.parent_id AND p.exclude_reports=1)' : '';
  const splitReport = input.scoped === 'report'
    ? ' AND sc.exclude_reports=0 AND NOT EXISTS(SELECT 1 FROM categories p WHERE p.id=sc.parent_id AND p.exclude_reports=1)' : '';
  const unsplit = 'NOT EXISTS(SELECT 1 FROM splits s WHERE s.transaction_id=t.id)';
  if (input.categoryId === null) clauses.push(`c.id IS NULL AND ${unsplit}`);
  if (input.categoryId) {
    add('categoryId', `((${unsplit} AND (c.id=@categoryId OR c.parent_id=@categoryId)${directReport})
      OR EXISTS(SELECT 1 FROM splits s JOIN categories sc ON sc.id=s.category_id
         WHERE s.transaction_id=t.id AND (sc.id=@categoryId OR sc.parent_id=@categoryId)${splitReport}))`, input.categoryId);
  }
  if (input.scoped === 'budget') clauses.push("t.exclude_budget=0 AND t.treatment='expense'");
  if (input.scoped === 'report') clauses.push(`t.exclude_reports=0 AND t.treatment<>'transfer' AND
    ((${unsplit}${directReport}) OR EXISTS(SELECT 1 FROM splits s JOIN categories sc ON sc.id=s.category_id WHERE s.transaction_id=t.id${splitReport}))`);
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const sort = input.sort === 'amount' ? 't.amount ASC,t.date DESC,t.id' :
    input.sort === 'oldest' ? 't.date ASC,t.id' : 't.date DESC,t.id';
  const categoryMatch = input.categoryId ? ' AND (sc.id=@categoryId OR sc.parent_id=@categoryId)' : '';
  const contribution = input.scoped
    ? `CASE WHEN ${unsplit} THEN t.amount ELSE
         (SELECT sum(s.amount) FROM splits s JOIN categories sc ON sc.id=s.category_id WHERE s.transaction_id=t.id${categoryMatch}${splitReport}) END`
    : 'NULL';
  const query = `${projection}, ${contribution} AS contribution ${joins} ${where} ORDER BY ${sort}`;
  if (all) return (db.prepare(query).all(bind) as Transaction[]).map(uiRow);
  const { total } = db.prepare(`SELECT count(*) AS total ${joins} ${where}`).get(bind) as { total: number };
  const rows = (db.prepare(query + ' LIMIT @limit OFFSET @offset')
    .all({ ...bind, limit: pageSize, offset: pageSize * input.page }) as Transaction[]).map(uiRow);
  return { rows, total, size: pageSize };
}

export function transactionDetail(db: Db, id: string): TransactionDetail {
  const row = db.prepare(`${projection}, NULL AS contribution ${joins} WHERE t.id=?`).get(id) as Transaction | undefined;
  if (!row) throw new UserError('Transaction could not be found.');
  const source = db.prepare("SELECT row_number,original FROM import_rows WHERE batch_id=? AND transaction_id=? AND state='accepted'")
    .get(row.batchId, id) as { row_number: number; original: string } | undefined;
  return {
    ...uiRow(row),
    splits: db.prepare('SELECT category_id AS categoryId,amount FROM splits WHERE transaction_id=? ORDER BY ordinal').all(id) as EditTransaction['splits'],
    sourceRow: source?.row_number ?? 0,
    original: source ? JSON.parse(source.original) as string[] : [],
  };
}

export function saveTransaction(db: Db, input: EditTransaction): TransactionDetail {
  return db.transaction(() => {
    const current = transactionDetail(db, input.id);
    if (current.pairId && (input.treatment !== 'transfer' || input.splits.length || input.categoryId !== current.categoryId)) {
      throw new UserError('Unlink the transfer before changing its classification.');
    }
    const eligible = new Map(categories(db).filter((category) => category.leaf).map((category) => [category.id, category] as const));
    for (const id of [...input.splits.map((split) => split.categoryId), ...(input.categoryId ? [input.categoryId] : [])]) {
      const category = eligible.get(id);
      const assigned = current.categoryId === id || current.splits.some((split) => split.categoryId === id);
      if (!category || (category.archived && !assigned)) throw new UserError('Select an active category.');
      const treatment = category.kind === 'savings' ? 'transfer' : category.kind;
      if (treatment !== input.treatment) throw new UserError('Category type must match transaction treatment.');
    }
    if (input.splits.length) {
      if (input.treatment === 'transfer' || input.splits.length < 2 ||
          input.splits.some((split) => !split.amount || Math.sign(split.amount) !== Math.sign(current.amount)) ||
          input.splits.reduce((total, split) => cents(total + split.amount), 0) !== current.amount) {
        throw new UserError('Split into at least two same-direction amounts that add up to the bank amount.');
      }
    }
    db.prepare('DELETE FROM splits WHERE transaction_id=?').run(input.id);
    const insert = db.prepare('INSERT INTO splits VALUES(?,?,?,?)');
    input.splits.forEach((line, ordinal) => insert.run(input.id, ordinal, line.categoryId, line.amount));
    const categoryId = input.splits.length ? null : input.categoryId;
    const classificationChanged = input.confirmClassification || current.treatment !== input.treatment || current.categoryId !== categoryId ||
      JSON.stringify(current.splits) !== JSON.stringify(input.splits);
    db.prepare(`UPDATE transactions SET category_id=@categoryId,treatment=@treatment,merchant=@merchant,notes=@notes,tags=@tags,
      exclude_budget=@excludeBudget,exclude_reports=@excludeReports,
      classification=@classification,rule_id=CASE WHEN @changed THEN NULL ELSE rule_id END WHERE id=@id`)
      .run({ ...input, categoryId, excludeBudget: Number(input.excludeBudget), excludeReports: Number(input.excludeReports),
        changed: Number(classificationChanged), classification: classificationChanged ? 'manual' : current.classification });
    return transactionDetail(db, input.id);
  })();
}
