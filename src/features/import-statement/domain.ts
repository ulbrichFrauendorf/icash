import { cents, normalizeText, parseDate, parseMoney } from '../../shared/finance';
import type { Candidate, Mapping } from './contract';

export function suggestMapping(headers: string[]): Partial<Mapping> {
  const find = (alias: RegExp) => {
    const index = headers.findIndex((header) => alias.test(normalizeText(header)));
    return index < 0 ? undefined : index;
  };
  const amount = find(/^(AMOUNT|TRANSACTION AMOUNT|VALUE)( \(ZAR\))?$/);
  return {
    date: find(/^(DATE|POSTING DATE|TRANSACTION DATE|TRANS DATE|VALUE DATE)$/),
    description: find(/^(DESCRIPTION|DETAILS|NARRATIVE|TRANSACTION DESCRIPTION|PAYEE)$/),
    amount,
    debit: amount === undefined ? find(/^(DEBIT|DEBITS|WITHDRAWALS|MONEY OUT)( \(ZAR\))?$/) : undefined,
    credit: amount === undefined ? find(/^(CREDIT|CREDITS|DEPOSITS|MONEY IN)( \(ZAR\))?$/) : undefined,
    balance: find(/^(BALANCE|RUNNING BALANCE|ACCOUNT BALANCE)( \(ZAR\))?$/),
    reference: find(/^(REFERENCE|TRANSACTION REFERENCE|REF)$/),
  };
}

export function suggestFormats(rows: string[][], columns: Partial<Mapping>): Partial<Mapping> {
  const values = (indexes: (number | undefined)[]) => rows
    .flatMap((row) => indexes.flatMap((index) => index === undefined ? [] : [row[index]?.trim() ?? '']))
    .filter(Boolean);
  const uniqueFormat = <Format extends string>(
    samples: string[], formats: readonly Format[], parse: (value: string, format: Format) => unknown,
  ): Format | undefined => {
    const matches = formats.filter((format) => samples.length > 0 && samples.every((sample) => {
      try { parse(sample, format); return true; }
      catch { return false; }
    }));
    return matches.length === 1 ? matches[0] : undefined;
  };
  return {
    dateFormat: uniqueFormat(values([columns.date]), ['ymd', 'dmy', 'mdy'] as const, parseDate),
    decimal: uniqueFormat(values([columns.amount, columns.debit, columns.credit, columns.balance]), ['.', ','] as const, parseMoney),
  };
}

export function normalizeRow(values: string[], mapping: Mapping): Candidate {
  const read = (index: number | undefined) => index === undefined ? '' : (values[index] ?? '').trim();
  const description = read(mapping.description);
  if (!description || description.length > 500) throw new Error('Description must contain 1–500 characters.');
  const debitText = read(mapping.debit);
  const creditText = read(mapping.credit);
  let amount: number;
  if (mapping.amount !== undefined) {
    amount = parseMoney(read(mapping.amount), mapping.decimal);
  } else {
    if (!debitText && !creditText) throw new Error('Debit or credit amount is required.');
    const debit = debitText ? parseMoney(debitText, mapping.decimal) : 0;
    const credit = creditText ? parseMoney(creditText, mapping.decimal) : 0;
    if (debit && credit || credit < 0) throw new Error('Debit and credit columns conflict.');
    amount = cents(credit - Math.abs(debit));
  }
  if (mapping.invert) amount = cents(-amount);
  const balance = read(mapping.balance);
  return { date: parseDate(read(mapping.date), mapping.dateFormat), description, amount,
    balance: balance ? parseMoney(balance, mapping.decimal) : null, reference: read(mapping.reference) || null };
}

export function matchKey(row: Candidate) {
  return JSON.stringify([row.date, row.amount, normalizeText(row.description)]);
}
