import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confirmCoverage, saveAccount } from '../src/features/accounts/main';
import { exportBackup, restoreBackup } from '../src/features/backup-restore/main';
import { categories, mergeCategories, restoreDefaults, saveCategory } from '../src/features/categories/main';
import { listRules, recategorize, saveRule } from '../src/features/categorization/main';
import { Imports } from '../src/features/import-statement/main';
import { mapping as mappingSchema, type ImportPreview, type Mapping } from '../src/features/import-statement/contract';
import { getBudget, recommend, saveAllocation, setClosed } from '../src/features/monthly-budget/main';
import { fullyCovered, scheduledAmount } from '../src/features/monthly-budget/domain';
import { ProfileStore } from '../src/features/profiles/main';
import { csvText, report } from '../src/features/reports/main';
import { goals, saveEntry, saveGoal } from '../src/features/savings-goals/main';
import { filters } from '../src/features/transactions/contract';
import { listTransactions, saveTransaction, transactionDetail } from '../src/features/transactions/main';
import { pairTransfer } from '../src/features/transfers/main';
import { checkIntegrity, openDatabase, schemaVersion } from '../src/platform/main/database';
import { parseDate, parseMoney } from '../src/shared/finance';
import { Templates, portableTemplate } from '../src/features/categories/portable';
import { detectSchedules, occurrencesInPeriod } from '../src/features/recurring/domain';

let root: string;
let store: ProfileStore;
let imports: Imports;
const testProtection = { wrap: (key: Buffer) => Buffer.from(key).reverse(), unwrap: (key: Buffer) => Buffer.from(key).reverse() };
const month = '2025-05';
const active = () => store.active();
const db = () => active().db;
const account = (name = 'Main', kind: 'current' | 'credit-card' | 'savings' = 'current') =>
  saveAccount(db(), { name, kind, archived: false }).find((row) => row.name === name)!;
const category = (name: string) => categories(db()).find((row) => row.name === name)!;
const transactions = () => listTransactions(db(), filters.parse({}), true);
const transaction = (description: string) => transactions().find((row) => row.description === description)!;
const monthlyReport = () => report(db(), { month, period: 'month' });
const fixture = (name: string) => resolve('tests/fixtures', name);
const file = (name: string, contents: string) => { const path = join(root, name); writeFileSync(path, contents); return path; };

async function preview(path: string, accountId: string, options: Partial<Mapping> = {}) {
  const { token, suggested, delimiter, encoding, header } = await imports.select(db(), active().id, accountId, path);
  const mapping = mappingSchema.parse({ ...suggested, delimiter, encoding, header, dateFormat: 'ymd', decimal: '.', ...options });
  const statement = imports.preview(db(), active().id, token, mapping);
  return { token, statement };
}
function commit(token: string, statement: ImportPreview, decisions: Record<string, 'keep' | 'skip'> = {}, acceptRejected = false) {
  return imports.commit(db(), active().id, { token, version: statement.version, decisions, acceptRejected });
}
async function importFile(path: string, accountId: string, options: Partial<Mapping> = {}) {
  const { token, statement } = await preview(path, accountId, options);
  return commit(token, statement);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'icash-test-'));
  store = new ProfileStore(root, testProtection);
  store.create('Household', true);
  imports = new Imports();
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('finance boundaries', () => {
  it('normalizes amounts and rejects invalid grouping, precision, range, and dates', () => {
    expect(parseMoney('(1.500,25)', ',')).toBe(-150025);
    expect(parseMoney('R 2 000.30', '.')).toBe(200030);
    expect(() => parseMoney('10,0.30', '.')).toThrow();
    expect(() => parseMoney('1.111', '.')).toThrow();
    expect(() => parseMoney('90071992547409.92', '.')).toThrow();
    expect(parseDate('29/02/2024', 'dmy')).toBe('2024-02-29');
    expect(() => parseDate('29/02/2025', 'dmy')).toThrow();
    expect(csvText('  =SUM(1)')).toBe("'  =SUM(1)");
    expect(Array.from({ length: 12 }, (_, index) => scheduledAmount(999, 'annual', '2025-' + String(index + 1).padStart(2, '0')))
      .reduce((sum, amount) => sum + amount)).toBe(999);
  });
  it('detects complete adjacent coverage and recognizes three recurring amounts', () => {
    expect(fullyCovered(month, [{ start: '2025-05-01', end: '2025-05-15' }, { start: '2025-05-16', end: '2025-05-31' }])).toBe(true);
    expect(fullyCovered(month, [{ start: '2025-05-02', end: '2025-05-31' }])).toBe(false);
    const schedules = detectSchedules(['2025-01-31','2025-02-28','2025-03-31'].map((date) => ({
      date, amount: -12000, description: 'Subscription', merchant: '',
    })));
    expect(schedules[0]).toMatchObject({ cadence: 'monthly', next: '2025-04-30', amount: -12000 });
    expect(occurrencesInPeriod('2025-01-31', 'monthly', '2025-02-01', '2025-03-30')).toBe(1);
    expect(occurrencesInPeriod('2025-01-01', 'weekly', '2025-02-01', '2025-02-28')).toBe(4);
  });
});

it('keeps profiles isolated, seeds once, and uses a genuinely encrypted database', () => {
  const profile = active().id;
  const grocery = category('Groceries');
  saveCategory(db(), { ...grocery, name: 'Food shops' });
  restoreDefaults(db());
  expect(category('Food shops').id).toBe(grocery.id);
  expect(schemaVersion(db())).toBe(1);
  expect(() => openDatabase(store.path(profile, 'ledger.sqlite'), randomBytes(32))).toThrow();
  const raw = new DatabaseSync(store.path(profile, 'ledger.sqlite'), { readOnly: true });
  expect(() => raw.prepare('SELECT name FROM profile').get()).toThrow();
  raw.close();
  store.create('Second household', false);
  expect(categories(db())).toHaveLength(0);
  store.select(profile);
  expect(category('Food shops').id).toBe(grocery.id);
  checkIntegrity(db());
});

it('imports both layouts, preserves identical purchases, and guards retries and overlap', async () => {
  const main = account();
  const statement = file('first.csv', 'Date,Description,Amount\n2025-05-01,Same shop,-10.00\n2025-05-01,Same shop,-10.00\n');
  expect((await importFile(statement, main.id)).inserted).toBe(2);
  expect((await importFile(statement, main.id)).inserted).toBe(0);
  const overlap = file('overlap.csv', 'Date,Description,Amount\n2025-05-01,Same shop,-10.00\n2025-05-01,Same shop,-10.00\n2025-05-02,New shop,-20.00\n');
  const overlapping = await preview(overlap, main.id);
  expect(overlapping.statement.counts.review).toBe(2);
  expect(() => commit(overlapping.token, overlapping.statement)).toThrow(/Review/);
  expect(commit(overlapping.token, overlapping.statement, { 2: 'skip', 3: 'skip' })).toMatchObject({ inserted: 1, duplicate: 2 });
  const partial = file('partial.csv', 'Date,Description,Amount\n2025-05-05,Valid,-10\n06/05/2025,Date repair,-2\n');
  const rejected = await preview(partial, main.id);
  expect(rejected.statement.counts.rejected).toBe(1);
  expect(commit(rejected.token, rejected.statement, {}, true).inserted).toBe(1);
  const corrected = await preview(partial, main.id, { dateFormat: 'dmy' });
  expect(commit(corrected.token, corrected.statement).inserted).toBe(1);
  const card = account('Card', 'credit-card');
  expect((await importFile(fixture('absa-card.csv'), card.id, { dateFormat: 'dmy', decimal: ',' })).inserted).toBe(2);
  expect(transaction('Shop purchase').amount).toBe(-30000);
  expect(transactions()).toHaveLength(7);
});

it('rolls back the entire import when a later database write fails', async () => {
  const main = account();
  const value = await preview(fixture('absa-current.csv'), main.id);
  db().exec(`CREATE TRIGGER fail_fixture BEFORE INSERT ON transactions WHEN new.description='Transfer to savings'
    BEGIN SELECT raise(ABORT, 'injected failure'); END;`);
  expect(() => commit(value.token, value.statement)).toThrow(/injected failure/);
  expect(transactions()).toHaveLength(0);
  expect(db().prepare('SELECT count(*) AS count FROM import_batches').get()).toEqual({ count: 0 });
});

it('keeps manual classifications and exact splits through bulk rules and merge', async () => {
  const main = account();
  await importFile(fixture('absa-current.csv'), main.id);
  const grocery = category('Supermarkets');
  const other = category('Household Supplies');
  const purchase = transactionDetail(db(), transaction('Checkers groceries').id);
  expect(purchase.categoryId).toBe(grocery.id);
  saveTransaction(db(), { ...purchase, splits: [{ categoryId: grocery.id, amount: -45000 }, { categoryId: other.id, amount: -5000 }] });
  const rule = listRules(db())[0]!;
  saveRule(db(), { ...rule, id: undefined, name: 'User override', categoryId: category('Fuel').id, priority: 1,
    conditions: { field: 'description', operator: 'contains', text: 'CHECKERS' } });
  expect(recategorize(db(), true).protected).toBe(1);
  expect(transactionDetail(db(), purchase.id).splits).toHaveLength(2);
  mergeCategories(db(), { from: other.id, to: grocery.id });
  expect(transactionDetail(db(), purchase.id).splits.map((line) => line.categoryId)).toEqual([grocery.id, grocery.id]);
  expect(listTransactions(db(), filters.parse({ text: 'Checkers' })).total).toBe(2);
});

it('reconciles reports, budgets, reversals, transfers, savings, and portable recovery', async () => {
  const main = account();
  const card = account('Card', 'credit-card');
  const savings = account('Savings', 'savings');
  await importFile(fixture('absa-current.csv'), main.id);
  await importFile(fixture('absa-card.csv'), card.id, { dateFormat: 'dmy', decimal: ',' });
  await importFile(fixture('absa-savings.csv'), savings.id);
  const groceries = category('Supermarkets');
  const refund = transactionDetail(db(), transaction('Checkers refund').id);
  saveTransaction(db(), { ...refund, categoryId: groceries.id, treatment: 'expense' });
  pairTransfer(db(), transaction('Card settlement').id, transaction('Settlement').id, 3);
  const pair = pairTransfer(db(), transaction('Transfer to savings').id, transaction('Savings contribution').id, 3);
  const goal = saveGoal(db(), { name: 'Emergency fund', target: 500000, due: null })[0]!;
  saveEntry(db(), { goalId: goal.id, pairId: pair.pairId, amount: 100000, date: '2025-05-05' });
  expect(() => saveEntry(db(), { goalId: goal.id, pairId: pair.pairId, amount: 100000, date: '2025-05-05' })).toThrow(/already/);
  saveAllocation(db(), { month, categoryId: groceries.id, amount: 200000, rollover: false });
  const reconcile = () => {
    expect(monthlyReport()).toMatchObject({ income: 1000000, expense: 72000, net: 928000, goalProgress: 100000 });
    expect(getBudget(db(), month).rows.find((row) => row.categoryId === groceries.id)).toMatchObject({ actual: 42000, remaining: 158000 });
    expect(goals(db())[0]?.progress).toBe(100000);
  };
  reconcile();
  expect((await importFile(fixture('absa-current.csv'), main.id)).inserted).toBe(0);
  const original = active().id;
  store.close();
  store.autoSelect();
  reconcile();
  const backup = join(root, 'household.icash-backup');
  exportBackup(store, backup, 'synthetic passphrase');
  expect(() => restoreBackup(store, backup, 'incorrect passphrase')).toThrow(/passphrase/);
  const damaged = readFileSync(backup);
  damaged[damaged.length - 1] = damaged.at(-1)! ^ 1;
  const damagedFile = join(root, 'damaged.icash-backup');
  writeFileSync(damagedFile, damaged);
  expect(() => restoreBackup(store, damagedFile, 'synthetic passphrase')).toThrow(/damaged/);
  const restored = restoreBackup(store, backup, 'synthetic passphrase');
  expect(restored.active?.id).not.toBe(original);
  reconcile();
  expect(report(db(), { month, period: 'year' })).toMatchObject({ income: 1000000, expense: 72000, net: 928000 });
});

it('requires verified coverage and preserves a closed budget revision after category edits', async () => {
  const main = account();
  await importFile(fixture('absa-current.csv'), main.id);
  const grocery = category('Supermarkets');
  expect(recommend(db(), '2025-06').months).toEqual([]);
  confirmCoverage(db(), { accountId: main.id, start: '2025-05-01', end: '2025-05-31' });
  expect(recommend(db(), '2025-06').months).toEqual([month]);
  expect(recommend(db(), '2025-06').rows.find((row) => row.categoryId === grocery.id)?.amount).toBe(50000);
  saveAllocation(db(), { month, categoryId: grocery.id, amount: 0, rollover: false });
  expect(getBudget(db(), month).rows.find((row) => row.categoryId === grocery.id)).toMatchObject({ allocated: 0, usage: null });
  expect(setClosed(db(), { month, closed: true }).revision).toBe(1);
  saveCategory(db(), { ...grocery, name: 'Markets' });
  expect(getBudget(db(), month)).toMatchObject({ changed: true, delta: 0, revision: 1 });
  setClosed(db(), { month, closed: false });
  expect(setClosed(db(), { month, closed: true }).revision).toBe(2);
});

it('previews and imports a portable category template into an independent profile', () => {
  const template = JSON.stringify(portableTemplate(db()));
  const original = active().id;
  store.create('Recipient', false);
  const templates = new Templates();
  const result = templates.preview(db(), active().id, template);
  expect(result.categories).toBeGreaterThan(30);
  expect(categories(db())).toHaveLength(0);
  templates.commit(db(), active().id, result.token);
  const recipientId = category('Groceries').id;
  store.select(original);
  expect(category('Groceries').id).not.toBe(recipientId);
});

it('imports and replays 50,000 rows while returning a bounded preview', async () => {
  const main = account();
  const rows = Array.from({ length: 50000 }, (_, index) => `2025-05-02,Synthetic purchase ${index},-0.01`);
  const statement = file('large.csv', ['Date,Description,Amount', ...rows].join('\n'));
  const first = await preview(statement, main.id);
  expect(first.statement.rows).toHaveLength(60);
  expect(first.statement.counts.accepted).toBe(50000);
  expect(first.statement.net).toBe(-50000);
  expect(commit(first.token, first.statement).inserted).toBe(50000);
  expect((await importFile(statement, main.id)).inserted).toBe(0);
  expect(listTransactions(db(), filters.parse({})).total).toBe(50000);
}, 30000);
