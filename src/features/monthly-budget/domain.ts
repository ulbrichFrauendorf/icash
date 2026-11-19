import { cents, monthEnd, shiftMonth } from '../../shared/finance';

function payDate(month: string, payDay: number) {
  const day = Math.min(payDay, Number(monthEnd(month).slice(-2)));
  return month + '-' + String(day).padStart(2, '0');
}

export function budgetPeriod(month: string, payDay = 25) {
  const previous = shiftMonth(month, -1);
  const start = payDate(previous, payDay);
  const cutoff = payDate(month, payDay);
  const day = Number(cutoff.slice(-2)) - 1;
  const end = day === 0 ? monthEnd(previous) : month + '-' + String(day).padStart(2, '0');
  return { start, end };
}

export function budgetMonth(date: string, payDay = 25) {
  const month = date.slice(0, 7);
  return date >= payDate(month, payDay) ? shiftMonth(month, 1) : month;
}

export function scheduledAmount(value: number, cadence: 'weekly' | 'monthly' | 'annual', month: string): number {
  if (cadence === 'monthly') return cents(value);
  if (cadence === 'weekly') return cents(Number((BigInt(value) * 52n + 6n) / 12n));
  const base = Math.floor(value / 12);
  return base + Number(Number(month.slice(5, 7)) <= value % 12);
}
