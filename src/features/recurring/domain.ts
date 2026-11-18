import { median, monthEnd, normalizeText, shiftMonth } from '../../shared/finance';
import type { Schedule } from './contract';

type Occurrence = { date: string; amount: number; description: string; merchant: string };

export function nextOccurrence(date: string, cadence: 'weekly' | 'monthly'): string {
  if (cadence === 'weekly') {
    const next = new Date(date + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 7);
    return next.toISOString().slice(0, 10);
  }
  const month = shiftMonth(date.slice(0, 7), 1);
  return month + '-' + String(Math.min(Number(date.slice(8)), Number(monthEnd(month).slice(8)))).padStart(2, '0');
}

export function detectSchedules(rows: Occurrence[]): Schedule[] {
  const groups = new Map<string, Occurrence[]>();
  for (const row of rows) {
    const key = (row.amount < 0 ? 'debit:' : 'credit:') + normalizeText(row.merchant || row.description);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].flatMap(([fingerprint, group]) => {
    const sample = group.sort((a, b) => a.date.localeCompare(b.date)).slice(-3);
    const first = sample[0], second = sample[1], last = sample[2];
    if (!first || !second || !last) return [];
    const days = (a: Occurrence, b: Occurrence) => (Date.parse(b.date) - Date.parse(a.date)) / 86400000;
    const intervals = [days(first, second), days(second, last)];
    const cadence = intervals.every((value) => value >= 6 && value <= 8) ? 'weekly' :
      intervals.every((value) => value >= 25 && value <= 35) ? 'monthly' : null;
    if (!cadence) return [];
    const amount = median(sample.map((row) => row.amount));
    if (!amount || sample.some((row) => Math.abs(row.amount - amount) > Math.max(100, Math.abs(amount) * 0.1))) return [];
    return [{ fingerprint, name: (last.merchant || last.description).slice(0, 80), amount, cadence,
      next: nextOccurrence(last.date, cadence), state: 'suggested' as const, evidence: sample }];
  });
}

export function occurrencesInPeriod(next: string, cadence: Schedule['cadence'], start: string, end: string): number {
  if (next > end) return 0;
  if (cadence === 'weekly') {
    const interval = 7 * 86400000;
    const anchor = Date.parse(next);
    const first = Math.max(0, Math.ceil((Date.parse(start) - anchor) / interval));
    const last = Math.floor((Date.parse(end) - anchor) / interval);
    return Math.max(0, last - first + 1);
  }
  const dueDay = Number(next.slice(8));
  const from = (next > start ? next : start).slice(0, 7);
  const to = end.slice(0, 7);
  let total = 0;
  for (let month = from; month <= to; month = shiftMonth(month, 1)) {
    const day = String(Math.min(dueDay, Number(monthEnd(month).slice(8)))).padStart(2, '0');
    const date = month + '-' + day;
    if (date >= next && date >= start && date <= end) total++;
    if (month === to) break;
  }
  return total;
}
