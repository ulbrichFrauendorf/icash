import type { Db } from '../platform/main/database';

export type LedgerLine = { id: string; accountId: string; date: string; amount: number; categoryId: string | null; treatment: 'income' | 'expense' };
export type LedgerScope = { start: string; end: string; accountId?: string };

export function ledgerLines(db: Db, scope: LedgerScope, use: 'budget' | 'report'): LedgerLine[] {
  const excludeTransaction = use === 'budget' ? 'exclude_budget' : 'exclude_reports';
  const report = use === 'report'
    ? `WHERE NOT EXISTS(SELECT 1 FROM categories c LEFT JOIN categories p ON p.id=c.parent_id
          WHERE c.id=lines.categoryId AND (c.exclude_reports=1 OR p.exclude_reports=1))` : '';
  return db.prepare(`
    WITH filtered AS (
      SELECT id,account_id,date,amount,category_id,treatment FROM transactions
      WHERE date>=@start AND date<=@end AND (@accountId IS NULL OR account_id=@accountId)
        AND treatment<>'transfer' AND ${excludeTransaction}=0
    ), lines AS (
      SELECT t.id,t.account_id AS accountId,t.date,t.amount,t.category_id AS categoryId,t.treatment
      FROM filtered t WHERE NOT EXISTS(SELECT 1 FROM splits s WHERE s.transaction_id=t.id)
      UNION ALL
      SELECT t.id,t.account_id,t.date,s.amount,s.category_id,t.treatment
      FROM filtered t JOIN splits s ON s.transaction_id=t.id
    )
    SELECT id,accountId,date,amount,categoryId,treatment FROM lines ${report}
  `).all({ ...scope, accountId: scope.accountId ?? null }) as LedgerLine[];
}
