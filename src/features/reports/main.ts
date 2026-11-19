import { stringify } from 'csv-stringify/sync';
import type { z } from 'zod';
import type { Db } from '../../platform/main/database';
import { cents, decimalMoney, median, shiftMonth } from '../../shared/finance';
import { ledgerLines } from '../../shared/ledger';
import { accounts } from '../accounts/main';
import { categories } from '../categories/main';
import { budgetMonth, budgetPeriod, fullyCovered } from '../monthly-budget/domain';
import { getBudget } from '../monthly-budget/main';
import { householdPayDay } from '../profiles/main';
import { nextOccurrence, occurrencesInPeriod } from '../recurring/domain';
import { schedules } from '../recurring/main';
import { goals } from '../savings-goals/main';
import type { Comparison, Report, reportInput } from './contract';

export function report(db: Db, input: z.infer<typeof reportInput>): Report {
  const { month, accountId, period } = input;
  const payDay = householdPayDay(db);
  const year = month.slice(0, 4);
  const firstMonth = period === 'year' ? year + '-01' : month;
  const lastMonth = period === 'year' ? year + '-12' : month;
  const priorFirst = shiftMonth(firstMonth, period === 'year' ? -12 : -1);
  const priorLast = shiftMonth(firstMonth, -1);
  const trendFirst = shiftMonth(lastMonth, -11);
  const first = [priorFirst, trendFirst, shiftMonth(firstMonth, -6)].sort()[0] ?? firstMonth;
  const start = budgetPeriod(firstMonth, payDay).start;
  const end = budgetPeriod(lastMonth, payDay).end;
  const list = categories(db);
  const byCategory = new Map(list.map((row) => [row.id, row]));
  const months = new Map<string, Comparison>();
  const spending = new Map<string, Map<string | null, number>>();
  const uncategorized = new Set<string>();
  const active = accountId ? accounts(db).filter((account) => account.id === accountId) : accounts(db).filter((account) => !account.archived);
  const coverage = db.prepare('SELECT account_id AS accountId,start,end FROM coverage').all() as { accountId: string; start: string; end: string }[];
  const covered = (month: string) => active.length > 0 && active.every((account) =>
    fullyCovered(month, coverage.filter((row) => row.accountId === account.id), payDay));
  for (const line of ledgerLines(db, { start: budgetPeriod(first, payDay).start, end, accountId }, 'report')) {
    const month = budgetMonth(line.date, payDay);
    const summary = months.get(month) ?? { month, income: 0, expense: 0, net: 0 };
    if (line.treatment === 'income') summary.income = cents(summary.income + line.amount);
    else {
      summary.expense = cents(summary.expense - line.amount);
      const category = line.categoryId ? byCategory.get(line.categoryId) : undefined;
      const id = category?.parentId ?? category?.id ?? null;
      const group = spending.get(month) ?? new Map();
      group.set(id, cents((group.get(id) ?? 0) - line.amount));
      spending.set(month, group);
    }
    summary.net = cents(summary.income - summary.expense);
    months.set(month, summary);
    if (!line.categoryId && line.date >= start && line.date <= end) uncategorized.add(line.id);
  }
  const monthsBetween = (from: string, to: string) => Array.from(
    { length: from === to ? 1 : 12 }, (_, index) => shiftMonth(from, index));
  const sumPeriod = (from: string, to: string) => {
    const result: Comparison = { month: from, income: 0, expense: 0, net: 0 };
    for (const key of monthsBetween(from, to)) {
      const row = months.get(key);
      if (!row) continue;
      result.income = cents(result.income + row.income);
      result.expense = cents(result.expense + row.expense);
    }
    result.net = cents(result.income - result.expense);
    return result;
  };
  const totals = sumPeriod(firstMonth, lastMonth);
  const scope = monthsBetween(firstMonth, lastMonth);
  const current = new Map<string | null, number>();
  for (const key of scope) {
    for (const [categoryId, amount] of spending.get(key) ?? []) current.set(categoryId, cents((current.get(categoryId) ?? 0) + amount));
  }
  const previousMonths = Array.from({ length: 6 }, (_, index) => shiftMonth(firstMonth, index - 6)).filter(covered);
  const allocations = scope.map((key) => getBudget(db, key));
  const total = (key: 'allocated' | 'actual' | 'remaining') => allocations.reduce((sum, value) => cents(sum + value[key]), 0);
  const recurring = accountId ? [] : schedules(db).filter((row) => row.state === 'confirmed' && row.amount < 0).flatMap((row) => {
    let next = row.next;
    const latest = row.evidence.at(-1)?.date;
    if (latest && latest >= next) next = nextOccurrence(latest, row.cadence);
    const amount = cents(-row.amount * occurrencesInPeriod(next, row.cadence, start, end));
    return amount ? [{ id: row.fingerprint, name: row.name, amount }] : [];
  }).sort((a, b) => b.amount - a.amount);
  const savings = goals(db).map(({ id, name, progress, target }) => ({ id, name, progress, target }));
  const commitments = recurring.reduce((sum, row) => cents(sum + row.amount), 0);
  return {
    ...totals, month, start, end, period, covered: scope.every(covered), uncategorized: uncategorized.size,
    allocated: total('allocated'), budgetActual: total('actual'), remaining: total('remaining'),
    goalProgress: savings.reduce((sum, goal) => cents(sum + goal.progress), 0), commitments,
    goals: savings, recurring,
    categories: [...current].map(([id, amount]) => {
      const history = previousMonths.map((key) => spending.get(key)?.get(id) ?? 0);
      const baseline = median(history);
      return { id, name: (id && byCategory.get(id)?.name) || 'Uncategorized', amount,
        baseline: history.length >= 3 ? baseline : null, historyMonths: history.length,
        unusual: period === 'month' && history.length >= 3 && amount > Math.max(baseline * 1.5, baseline + 10000) };
    }).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)),
    prior: sumPeriod(priorFirst, priorLast),
    trend: Array.from({ length: 12 }, (_, index) => {
      const key = shiftMonth(trendFirst, index);
      return months.get(key) ?? { month: key, income: 0, expense: 0, net: 0 };
    }),
  };
}

export function csvText(value: string): string {
  return /^[\s\uFEFF]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? "'" + value : value;
}

export function csv(headers: string[], rows: (string | number | null)[][]): string {
  return stringify([headers, ...rows.map((row) => row.map((value) => typeof value === 'string' ? csvText(value) : value))], { bom: true });
}

export function numericCsv(headers: string[], rows: (string | number | null)[][]): string {
  return stringify([headers, ...rows.map((row) => row.map((value) =>
    typeof value === 'number' ? decimalMoney(value) : typeof value === 'string' ? csvText(value) : value))], { bom: true });
}
