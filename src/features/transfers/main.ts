import { randomUUID } from 'node:crypto';
import type { Db } from '../../platform/main/database';
import { UserError } from '../../shared/schema';
import { transactionDetail } from '../transactions/main';
import type { TransferCandidate } from './contract';

export function transferCandidates(db: Db, id: string, days: number): TransferCandidate[] {
  const source = transactionDetail(db, id);
  if (!source.amount || source.pairId || source.hasSplits) return [];
  return db.prepare(`SELECT t.id,t.date,t.amount,t.description,a.name AS account FROM transactions t
      JOIN accounts a ON a.id=t.account_id
    WHERE t.account_id<>@account AND t.amount=-@amount AND abs(julianday(t.date)-julianday(@date))<=@days
      AND NOT EXISTS(SELECT 1 FROM transfer_legs WHERE transaction_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM splits WHERE transaction_id=t.id)
    ORDER BY abs(julianday(t.date)-julianday(@date)),t.date,t.id LIMIT 50`)
    .all({ account: source.accountId, amount: source.amount, date: source.date, days }) as TransferCandidate[];
}

export function pairTransfer(db: Db, first: string, second: string, days: number) {
  db.transaction(() => {
    if (!transferCandidates(db, first, days).some((candidate) => candidate.id === second)) {
      throw new UserError('Choose an available equal-and-opposite transaction from another account.');
    }
    const pair = randomUUID();
    db.prepare('INSERT INTO transfer_pairs VALUES(?)').run(pair);
    for (const id of [first, second]) {
      const previous = db.prepare('SELECT treatment,category_id,classification,rule_id FROM transactions WHERE id=?').get(id);
      db.prepare('INSERT INTO transfer_legs VALUES(?,?,?)').run(id, pair, JSON.stringify(previous));
      db.prepare("UPDATE transactions SET treatment='transfer',category_id=NULL,classification='manual',rule_id=NULL WHERE id=?").run(id);
    }
  })();
  return transactionDetail(db, first);
}

export function unlinkTransfer(db: Db, pair: string) {
  return db.transaction(() => {
    if (db.prepare('SELECT id FROM goal_entries WHERE pair_id=?').get(pair)) {
      throw new UserError('Remove the linked savings entry before unlinking this transfer.');
    }
    const legs = db.prepare('SELECT transaction_id,previous FROM transfer_legs WHERE pair_id=?').all(pair) as { transaction_id: string; previous: string }[];
    const restore = db.prepare(`UPDATE transactions SET treatment=@treatment,category_id=@category_id,
      classification=@classification,rule_id=@rule_id WHERE id=@id`);
    for (const leg of legs) restore.run({ ...JSON.parse(leg.previous), id: leg.transaction_id });
    db.prepare('DELETE FROM transfer_pairs WHERE id=?').run(pair);
  })();
}
