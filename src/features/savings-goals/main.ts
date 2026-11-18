import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Db } from '../../platform/main/database';
import { cents } from '../../shared/finance';
import { UserError } from '../../shared/schema';
import type { entryInput, Goal, GoalEntry, goalInput } from './contract';

export function goals(db: Db): Goal[] {
  const rows = db.prepare('SELECT id,name,target,due FROM goals ORDER BY name,id').all() as Omit<Goal, 'progress' | 'entries'>[];
  const entries = db.prepare(`SELECT id,goal_id AS goalId,pair_id AS pairId,amount,date FROM goal_entries ORDER BY date DESC,id`).all() as GoalEntry[];
  return rows.map((row) => {
    const matches = entries.filter((entry) => entry.goalId === row.id);
    return { ...row, entries: matches, progress: matches.reduce((total, entry) => cents(total + entry.amount), 0) };
  });
}

export function saveGoal(db: Db, input: z.infer<typeof goalInput>) {
  db.prepare(`INSERT INTO goals VALUES(@id,@name,@target,@due)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,target=excluded.target,due=excluded.due`)
    .run({ ...input, id: input.id ?? randomUUID() });
  return goals(db);
}

export function saveEntry(db: Db, input: z.infer<typeof entryInput>) {
  if (!db.prepare('SELECT id FROM goals WHERE id=?').get(input.goalId)) throw new UserError('Goal was not found.');
  if (input.pairId) {
    if (!db.prepare('SELECT id FROM transfer_pairs WHERE id=?').get(input.pairId)) throw new UserError('Pair the transfer first.');
    if (db.prepare('SELECT id FROM goal_entries WHERE pair_id=?').get(input.pairId)) throw new UserError('This transfer already counts toward a goal.');
    const amount = db.prepare(`SELECT abs(t.amount) AS value FROM transfer_legs l JOIN transactions t ON t.id=l.transaction_id
      WHERE l.pair_id=? LIMIT 1`).get(input.pairId) as { value: number };
    if (Math.abs(input.amount) !== amount.value) throw new UserError('A linked contribution must match the transfer amount.');
  }
  db.prepare('INSERT INTO goal_entries VALUES(@id,@goalId,@pairId,@amount,@date)').run({ ...input, id: randomUUID() });
  return goals(db);
}

export function removeEntry(db: Db, id: string) {
  db.prepare('DELETE FROM goal_entries WHERE id=?').run(id);
  return goals(db);
}

export function goalTransfers(db: Db) {
  return db.prepare(`SELECT p.id,min(t.date) AS date,max(abs(t.amount)) AS amount,
    group_concat(a.name, ' / ') AS label FROM transfer_pairs p JOIN transfer_legs l ON l.pair_id=p.id
    JOIN transactions t ON t.id=l.transaction_id JOIN accounts a ON a.id=t.account_id
    WHERE NOT EXISTS(SELECT 1 FROM goal_entries e WHERE e.pair_id=p.id)
    GROUP BY p.id ORDER BY date DESC LIMIT 250`).all() as { id: string; date: string; amount: number; label: string }[];
}
