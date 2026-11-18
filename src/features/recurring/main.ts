import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Db } from '../../platform/main/database';
import { localDate, shiftMonth } from '../../shared/finance';
import { detectSchedules } from './domain';
import type { Schedule, scheduleInput } from './contract';

export function schedules(db: Db): Schedule[] {
  const saved = db.prepare('SELECT fingerprint,name,amount,cadence,next,state FROM schedules').all() as
    (Omit<Schedule, 'evidence' | 'state'> & { state: string })[];
  const known = new Set(saved.map((row) => row.fingerprint));
  const from = shiftMonth(localDate().slice(0, 7), -12) + '-01';
  const rows = db.prepare(`SELECT date,amount,description,merchant FROM transactions
    WHERE treatment<>'transfer' AND exclude_reports=0 AND date>=? AND amount<>0`)
    .all(from) as Parameters<typeof detectSchedules>[0];
  const detected = detectSchedules(rows);
  const byKey = new Map(detected.map((row) => [row.fingerprint, row]));
  return [...saved.filter((row) => row.state === 'confirmed').map((row) => ({
    ...row, state: 'confirmed' as const, evidence: byKey.get(row.fingerprint)?.evidence ?? [],
  })), ...detected.filter((row) => !known.has(row.fingerprint))].sort((a, b) => a.next.localeCompare(b.next));
}

export function saveSchedule(db: Db, input: z.infer<typeof scheduleInput>) {
  db.prepare(`INSERT INTO schedules VALUES(@id,@fingerprint,@name,@amount,@cadence,@next,@state)
    ON CONFLICT(fingerprint) DO UPDATE SET name=excluded.name,amount=excluded.amount,
      cadence=excluded.cadence,next=excluded.next,state=excluded.state`)
    .run({ ...input, id: randomUUID() });
  return schedules(db);
}
