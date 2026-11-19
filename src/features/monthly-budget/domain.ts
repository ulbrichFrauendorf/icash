import { cents, monthEnd, shiftMonth } from '../../shared/finance';

function payDate(month: string, payDay: number) {
  const day = Math.min(payDay, Number(monthEnd(month).slice(-2)));
  return month + '-' + String(day).padStart(2, '0');
}

export function budgetPeriod(month: string, payDay: number | null) {
  if (payDay === null) return { start: month + '-01', end: monthEnd(month) };
  const previous = shiftMonth(month, -1);
  const start = payDate(previous, payDay);
  const cutoff = payDate(month, payDay);
  const day = Number(cutoff.slice(-2)) - 1;
  const end = day === 0 ? monthEnd(previous) : month + '-' + String(day).padStart(2, '0');
  return { start, end };
}

export function budgetMonth(date: string, payDay: number | null) {
  const month = date.slice(0, 7);
  return payDay !== null && date >= payDate(month, payDay) ? shiftMonth(month, 1) : month;
}

export function scheduledAmount(value: number, cadence: 'weekly' | 'monthly' | 'annual', month: string): number {
  if (cadence === 'monthly') return cents(value);
  if (cadence === 'weekly') return cents(Number((BigInt(value) * 52n + 6n) / 12n));
  const base = Math.floor(value / 12);
  return base + Number(Number(month.slice(5, 7)) <= value % 12);
}

export function fullyCovered(month: string, periods: { start: string; end: string }[], payDay: number | null = null) {
  const { start, end } = budgetPeriod(month, payDay);
  let next = start;
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
