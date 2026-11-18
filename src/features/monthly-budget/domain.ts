import { cents, monthEnd } from '../../shared/finance';

export function scheduledAmount(value: number, cadence: 'weekly' | 'monthly' | 'annual', month: string): number {
  if (cadence === 'monthly') return cents(value);
  if (cadence === 'weekly') return cents(Number((BigInt(value) * 52n + 6n) / 12n));
  const base = Math.floor(value / 12);
  return base + Number(Number(month.slice(5, 7)) <= value % 12);
}

export function fullyCovered(month: string, periods: { start: string; end: string }[]) {
  let next = month + '-01';
  const end = monthEnd(month);
  for (const period of [...periods].sort((a, b) => a.start.localeCompare(b.start))) {
    if (period.start > next) return false;
    if (period.end < next) continue;
    if (period.end >= end) return true;
    const day = new Date(period.end + 'T00:00:00Z');
    day.setUTCDate(day.getUTCDate() + 1);
    next = day.toISOString().slice(0, 10);
  }
  return false;
}
