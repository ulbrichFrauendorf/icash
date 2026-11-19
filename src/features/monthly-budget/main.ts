import type { z } from 'zod';
import type { Db } from '../../platform/main/database';
import { cents, median, monthEnd, shiftMonth } from '../../shared/finance';
import { ledgerLines } from '../../shared/ledger';
import { UserError } from '../../shared/schema';
import { accounts } from '../accounts/main';
import { categories } from '../categories/main';
import { householdPayDay } from '../profiles/main';
import { budgetMonth, budgetPeriod, scheduledAmount } from './domain';
import type { allocationInput, Budget, BudgetRow, closeInput, copyInput, defaultInput, Recommendations } from './contract';

type Allocation = { categoryId: string; amount: number | null; rollover: number };
type Schedule = Allocation & { effective: string; cadence: 'weekly' | 'monthly' | 'annual' };

function status(db: Db, month: string) {
  return Boolean((db.prepare('SELECT closed FROM budget_status WHERE month=?').get(month) as { closed: number } | undefined)?.closed);
}

function assertEditable(db: Db, month: string, categoryId?: string) {
  if (status(db, month)) throw new UserError('Reopen this month before editing it.');
  if (categoryId && !categories(db).some((item) => item.id === categoryId && item.kind === 'expense' && item.leaf && !item.archived)) {
    throw new UserError('Select an active expense category.');
  }
}

function numbers(allocated: number | null, rollover: number, actual: number) {
  const available = allocated === null ? null : cents(allocated + rollover);
  return { allocated, rollover, actual, remaining: available === null ? null : cents(available - actual),
    variance: available === null ? null : cents(actual - available), usage: available && available > 0 ? (actual / available) * 100 : null };
}

function liveBudget(db: Db, month: string): Budget {
  const payDay = householdPayDay(db);
  const period = budgetPeriod(month, payDay);
  const list = categories(db).filter((item) => item.kind === 'expense');
  const overrides = db.prepare(`SELECT month,category_id AS categoryId,allocation AS amount,rollover
    FROM monthly_allocations WHERE month<=? ORDER BY month`).all(month) as (Allocation & { month: string })[];
  const schedules = db.prepare(`SELECT effective,category_id AS categoryId,amount,cadence,rollover
    FROM budget_defaults WHERE effective<=? ORDER BY effective`).all(month) as Schedule[];
  const earliest = [month, overrides[0]?.month ?? month, schedules[0]?.effective ?? month].sort()[0] ?? month;
  const explicit = new Map(overrides.map((item) => [item.month + item.categoryId, item]));
  const scheduleBy = new Map<string, Schedule[]>();
  for (const schedule of schedules) {
    const history = scheduleBy.get(schedule.categoryId) ?? [];
    history.unshift(schedule);
    scheduleBy.set(schedule.categoryId, history);
  }
  const actuals = new Map<string, number>();
  for (const line of ledgerLines(db, { start: budgetPeriod(earliest, payDay).start, end: period.end }, 'budget')) {
    if (line.treatment !== 'expense') continue;
    const key = budgetMonth(line.date, payDay) + (line.categoryId ?? '');
    actuals.set(key, cents((actuals.get(key) ?? 0) - line.amount));
  }
  const closureRows = db.prepare(`SELECT r.month,r.snapshot FROM budget_revisions r JOIN budget_status s ON s.month=r.month AND s.closed=1
    WHERE r.month>=? AND r.month<? AND r.revision=(SELECT max(revision) FROM budget_revisions WHERE month=r.month)`)
    .all(earliest, month) as { month: string; snapshot: string }[];
  const closed = new Map(closureRows.map((row) => [row.month, new Map((JSON.parse(row.snapshot) as Budget).rows.map((entry) => [entry.categoryId, entry]))]));
  const rows: BudgetRow[] = [];
  for (const item of list.filter((entry) => entry.leaf)) {
    let carry = 0;
    let row: BudgetRow | undefined;
    for (let cursor = earliest; cursor <= month; cursor = shiftMonth(cursor, 1)) {
      const schedule = scheduleBy.get(item.id)?.find((entry) => entry.effective <= cursor);
      const entry = explicit.get(cursor + item.id);
      const amount = entry?.amount ?? (schedule?.amount == null ? null : scheduledAmount(schedule.amount, schedule.cadence, cursor));
      const actual = actuals.get(cursor + item.id) ?? 0;
      const calculated = numbers(amount, amount === null ? 0 : carry, actual);
      const snapshot = closed.get(cursor)?.get(item.id);
      const carryForward = Boolean(entry?.rollover ?? schedule?.rollover);
      carry = (snapshot?.carryForward ?? carryForward)
        ? Math.max(0, (snapshot ? snapshot.remaining : calculated.remaining) ?? 0) : 0;
      if (cursor === month) {
        row = { categoryId: item.id, name: item.name, parent: item.parentId, leaf: true, archived: item.archived, carryForward, ...calculated };
        break;
      }
    }
    if (row && (!item.archived || row.allocated !== null || row.actual !== 0)) rows.push(row);
  }
  const uncategorized = actuals.get(month) ?? 0;
  rows.push({ categoryId: null, name: 'Uncategorized', parent: null, leaf: true, archived: false, carryForward: false, ...numbers(null, 0, uncategorized) });
  const sum = (selected: BudgetRow[], key: 'allocated' | 'rollover' | 'actual') =>
    selected.reduce((total, row) => cents(total + (row[key] ?? 0)), 0);
  const parents = list.filter((entry) => !entry.leaf).flatMap((item): BudgetRow[] => {
    const children = rows.filter((row) => row.parent === item.id);
    if (item.archived && !children.length) return [];
    const allocation = children.some((row) => row.allocated !== null) ? sum(children, 'allocated') : null;
    return [{ categoryId: item.id, name: item.name, parent: null, leaf: false, archived: item.archived, carryForward: false,
      ...numbers(allocation, sum(children, 'rollover'), sum(children, 'actual')) }];
  });
  const allocated = sum(rows, 'allocated');
  const rollover = sum(rows, 'rollover');
  const actual = sum(rows, 'actual');
  return { month, ...period, rows: [...parents, ...rows], allocated, rollover, actual, remaining: cents(allocated + rollover - actual),
    closed: false, delta: null, revision: null, changed: false };
}

export function getBudget(db: Db, month: string): Budget {
  const live = liveBudget(db, month);
  const latest = db.prepare('SELECT revision,snapshot FROM budget_revisions WHERE month=? ORDER BY revision DESC LIMIT 1')
    .get(month) as { revision: number; snapshot: string } | undefined;
  if (!latest || !status(db, month)) return { ...live, revision: latest?.revision ?? null };
  const saved = JSON.parse(latest.snapshot) as Budget;
  const savedPeriod = { start: saved.start ?? month + '-01', end: saved.end ?? monthEnd(month) };
  return { ...saved, ...savedPeriod, closed: true, revision: latest.revision,
    delta: cents(live.actual - saved.actual),
    changed: live.start !== savedPeriod.start || live.end !== savedPeriod.end || JSON.stringify(live.rows) !== JSON.stringify(saved.rows) };
}

export function saveAllocation(db: Db, input: z.infer<typeof allocationInput>) {
  return db.transaction(() => {
    assertEditable(db, input.month, input.categoryId);
    if (input.amount === null) db.prepare('DELETE FROM monthly_allocations WHERE month=? AND category_id=?').run(input.month, input.categoryId);
    else db.prepare(`INSERT INTO monthly_allocations VALUES(?,?,?,?) ON CONFLICT(month,category_id)
      DO UPDATE SET allocation=excluded.allocation,rollover=excluded.rollover`)
      .run(input.month, input.categoryId, input.amount, Number(input.rollover));
    return getBudget(db, input.month);
  })();
}

export function saveDefault(db: Db, input: z.infer<typeof defaultInput>) {
  return db.transaction(() => {
    assertEditable(db, input.month, input.categoryId);
    db.prepare(`INSERT INTO budget_defaults VALUES(?,?,?,?,?) ON CONFLICT(effective,category_id)
      DO UPDATE SET amount=excluded.amount,cadence=excluded.cadence,rollover=excluded.rollover`)
      .run(input.month, input.categoryId, input.amount, input.cadence, Number(input.rollover));
    return getBudget(db, input.month);
  })();
}

export function copyBudget(db: Db, { from, month }: z.infer<typeof copyInput>) {
  assertEditable(db, month);
  if (from >= month) throw new UserError('Choose an earlier budget month.');
  return db.transaction(() => {
    const add = db.prepare('INSERT OR IGNORE INTO monthly_allocations VALUES(?,?,?,?)');
    const enabled = new Set(categories(db).filter((entry) => entry.leaf && !entry.archived && entry.kind === 'expense').map((entry) => entry.id));
    for (const row of getBudget(db, from).rows) {
      if (row.leaf && row.categoryId && row.allocated !== null && enabled.has(row.categoryId)) {
        add.run(month, row.categoryId, row.allocated, Number(row.carryForward));
      }
    }
    return getBudget(db, month);
  })();
}

export function setClosed(db: Db, { month, closed }: z.infer<typeof closeInput>) {
  return db.transaction(() => {
    const current = status(db, month);
    if (closed && !current) {
      db.prepare(`INSERT INTO budget_revisions VALUES(?,(SELECT coalesce(max(revision),0)+1 FROM budget_revisions WHERE month=?),?,?)`)
        .run(month, month, JSON.stringify(liveBudget(db, month)), new Date().toISOString());
    }
    db.prepare('INSERT INTO budget_status VALUES(?,?) ON CONFLICT(month) DO UPDATE SET closed=excluded.closed')
      .run(month, Number(closed));
    return getBudget(db, month);
  })();
}

export function recommend(db: Db, month: string): Recommendations {
  const payDay = householdPayDay(db);
  const active = accounts(db).filter((account) => !account.archived);
  const periods = Array.from({ length: 6 }, (_, index) => shiftMonth(month, index - 6));
  const observed = new Set<string>();
  const accountIds = new Set(active.map((account) => account.id));
  const actuals = new Map<string, number>();
  for (const line of ledgerLines(db, { start: budgetPeriod(periods[0]!, payDay).start, end: budgetPeriod(periods.at(-1)!, payDay).end }, 'budget')) {
    const period = budgetMonth(line.date, payDay);
    if (!accountIds.has(line.accountId)) continue;
    observed.add(period);
    if (line.treatment !== 'expense' || !line.categoryId) continue;
    const key = line.categoryId + period;
    actuals.set(key, cents((actuals.get(key) ?? 0) - line.amount));
  }
  const months = periods.filter((period) => observed.has(period));
  return { months, rows: categories(db).filter((item) => item.kind === 'expense' && item.leaf && !item.archived).map((item) => {
    const values = months.map((period) => actuals.get(item.id + period) ?? 0);
    return { categoryId: item.id, name: item.name, amount: values.length ? Math.max(0, median(values)) : null,
      average: values.length ? Math.round(values.reduce((sum, value) => sum + value / values.length, 0)) : null,
      minimum: values.length ? Math.min(...values) : null, maximum: values.length ? Math.max(...values) : null,
      trend: values.length > 1 ? cents((values.at(-1) ?? 0) - (values[0] ?? 0)) : null };
  }) };
}
