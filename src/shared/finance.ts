export function cents(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('Amount exceeds the supported range.');
  return value === 0 ? 0 : value;
}

export function parseMoney(input: string, decimal: '.' | ','): number {
  let value = input.trim().replace(/^R\s*/i, '').replace(/\s*ZAR$/i, '').trim();
  const negative = value.startsWith('-') || /^\(.*\)$/.test(value);
  value = (value.startsWith('(') ? value.replace(/^\((.*)\)$/, '$1') : value.replace(/^[+-]/, ''))
    .trim().replace(/^R\s*/i, '');
  const parts = value.split(decimal);
  const [whole, fraction = ''] = parts;
  if (parts.length > 2 || !whole || !/^\d{0,2}$/.test(fraction) ||
      (parts.length === 2 && fraction.length === 0)) throw new Error('Invalid amount.');
  const separator = decimal === '.' ? ',' : '.';
  const grouping = whole.includes(separator) ? separator : /[ \u00a0\u202f]/.test(whole) ? ' ' : '';
  const groups = whole.replace(/[\u00a0\u202f]/g, ' ').split(grouping || '\u0000');
  if (!groups.every((group, index) => /^\d+$/.test(group) &&
    (groups.length === 1 || (index === 0 ? group.length <= 3 : group.length === 3)))) {
    throw new Error('Invalid thousands grouping.');
  }
  const minor = BigInt(groups.join('')) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents(Number(negative ? -minor : minor));
}

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseDate(value: string, format: 'ymd' | 'dmy' | 'mdy'): string {
  const parts = value.trim().split(/[-/.]/);
  if (parts.length !== 3 || !parts.every((part) => /^\d+$/.test(part))) throw new Error('Invalid date.');
  const [a = '', b = '', c = ''] = parts;
  const [year, month, day] = format === 'ymd' ? [a, b, c] : format === 'dmy' ? [c, b, a] : [c, a, b];
  const result = [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');
  if (!validDate(result)) throw new Error('Invalid date for selected format.');
  return result;
}

export function localDate(now = new Date()): string {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, '0')).join('-');
}

export function shiftMonth(month: string, offset: number): string {
  const [year = 0, number = 1] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + offset, 1)).toISOString().slice(0, 7);
}

export function monthEnd(month: string): string {
  const [year = 0, number = 1] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

export function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle] ?? 0;
  return sorted.length % 2 ? high : Math.round((sorted[middle - 1] ?? 0) / 2 + high / 2);
}

export function decimalMoney(value: number): string {
  const absolute = BigInt(Math.abs(cents(value)));
  return (value < 0 ? '-' : '') + String(absolute / 100n) + '.' + String(absolute % 100n).padStart(2, '0');
}
