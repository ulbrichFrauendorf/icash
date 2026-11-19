import { migrations } from '../src/platform/main/migrations';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiCategorization, reviewSample } from '../src/features/openai/main';
import { OpenAiClient } from '../src/features/openai/client';
import { saveAccount } from '../src/features/accounts/main';
import { exportBackup, restoreBackup } from '../src/features/backup-restore/main';
import { categories, deleteCategory, previewCategoryDeletion, restoreDefaults, saveCategory } from '../src/features/categories/main';
import { listRules, recategorize, saveRule } from '../src/features/categorization/main';
import { Imports } from '../src/features/import-statement/main';
import { commitInput, mapping as mappingSchema, type ImportPreview, type Mapping } from '../src/features/import-statement/contract';
import { getBudget, recommend, saveAllocation, setClosed } from '../src/features/monthly-budget/main';
import { budgetMonth, budgetPeriod, scheduledAmount } from '../src/features/monthly-budget/domain';
import { ProfileStore } from '../src/features/profiles/main';
import { csvText, report } from '../src/features/reports/main';
import { goals, saveEntry, saveGoal } from '../src/features/savings-goals/main';
import { filters } from '../src/features/transactions/contract';
import { listTransactions, saveTransaction, transactionDetail } from '../src/features/transactions/main';
import { pairTransfer } from '../src/features/transfers/main';
import { checkIntegrity, migrate, openDatabase, schemaVersion } from '../src/platform/main/database';
import { parseDate, parseMoney } from '../src/shared/finance';
import { Templates, portableTemplate } from '../src/features/categories/portable';

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
const transactions = () => listTransactions(db(), filters.parse({}));
const transaction = (description: string) => transactions().find((row) => row.description === description)!;
const monthlyReport = () => report(db(), { month, period: 'month' });
const fixture = (name: string) => resolve('tests/fixtures', name);
const file = (name: string, contents: string) => { const path = join(root, name); writeFileSync(path, contents); return path; };

async function preview(path: string, accountId: string, options: Partial<Mapping> = {}) {
  const { token, suggested, delimiter, encoding, header } = await imports.select(db(), active().id, accountId, path);
  const mapping = mappingSchema.parse({ ...suggested, delimiter, encoding, header, dateFormat: suggested.dateFormat ?? 'ymd', decimal: suggested.decimal ?? '.', ...options });
  const statement = imports.preview(db(), active().id, token, mapping);
  return { token, statement };
}
function commit(token: string, statement: ImportPreview, acceptRejected = false) {
  return imports.commit(db(), active().id, { token, version: statement.version, acceptRejected });
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
    expect(parseDate('20240229', 'ymd')).toBe('2024-02-29');
    expect(() => parseDate('20250229', 'ymd')).toThrow(/posting date/);
    expect(parseDate('29/02/2024', 'dmy')).toBe('2024-02-29');
    expect(() => parseDate('29/02/2025', 'dmy')).toThrow();
    expect(csvText('  =SUM(1)')).toBe("'  =SUM(1)");
    expect(Array.from({ length: 12 }, (_, index) => scheduledAmount(999, 'annual', '2025-' + String(index + 1).padStart(2, '0')))
      .reduce((sum, amount) => sum + amount)).toBe(999);
  });
});

it('keeps profiles isolated, seeds once, and uses a genuinely encrypted database', () => {
  const profile = active().id;
  const grocery = category('Groceries');
  saveCategory(db(), { ...grocery, name: 'Food shops' });
  restoreDefaults(db());
  expect(category('Food shops').id).toBe(grocery.id);
  expect(schemaVersion(db())).toBe(3);
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

it('upgrades legacy assignments and rejects group targets even when the group is empty', () => {
  const legacy = openDatabase(join(root, 'legacy.sqlite'), randomBytes(32), false);
  try {
    legacy.exec(migrations[0]);
    legacy.exec(migrations[1]);
    legacy.pragma('user_version = 2');
    legacy.exec(`INSERT INTO profile(name,pay_day) VALUES('Existing household',12);
      INSERT INTO accounts(id,name,kind) VALUES('bank','Bank','current');
      INSERT INTO import_batches VALUES('batch','bank','statement','file','mapping','2026-01-05',1);
      INSERT INTO categories(id,name,kind,colour) VALUES('fuel','Fuel','expense','#000000'),
        ('shopping','Shopping','expense','#000000'),('empty','Empty group','expense','#000000');
      INSERT INTO transactions(id,account_id,batch_id,date,amount,description,normalized,treatment,category_id)
        VALUES('a','bank','batch','2026-01-05',-200,'A','A','expense','fuel'),
        ('b','bank','batch','2026-01-05',-300,'B','B','expense','shopping');`);
    migrate(legacy);
    const assigned = legacy.prepare(`SELECT t.id, c.name, p.name AS parent FROM transactions t
      JOIN categories c ON c.id=t.category_id JOIN categories p ON p.id=c.parent_id ORDER BY t.id`).all();
    expect(assigned).toEqual([{ id: 'a', name: 'Fuel', parent: 'Transport' }, { id: 'b', name: 'General', parent: 'Shopping' }]);
    expect(legacy.prepare('SELECT pay_day FROM profile').get()).toEqual({ pay_day: 12 });
    expect(categories(legacy).find((row) => row.id === 'empty')?.leaf).toBe(false);
    expect(() => legacy.exec("UPDATE transactions SET category_id='empty' WHERE id='a'")).toThrow(/within a group/);
    expect(() => saveAllocation(legacy, { month, categoryId: 'empty', amount: 200, rollover: false })).toThrow();
    checkIntegrity(legacy);
  } finally { legacy.close(); }
});

it('imports both layouts, preserves distinguishable repeats, and skips duplicates', async () => {
  const main = account();
  const original = file('first.csv', [
    'Date,Description,Amount,Balance',
    '20250501,Synthetic shop,-10.00,90.00',
    '20250501,Synthetic shop,-10.00,80.00',
    '20250501, synthetic SHOP ,-10.00,80.00',
  ].join('\n'));
  expect((await imports.select(db(), active().id, main.id, original)).suggested)
    .toMatchObject({ dateFormat: 'ymd', decimal: '.', balance: 3 });
  const initial = await preview(original, main.id);
  expect(initial.statement.reconciliation).toBeNull();
  expect(initial.statement.net).toBe(-2000);
  expect(commit(initial.token, initial.statement)).toMatchObject({ inserted: 2, duplicate: 1 });
  expect((await importFile(original, main.id))).toMatchObject({ inserted: 0, duplicate: 3 });
  const overlap = file('overlap.csv', [
    'Date,Description,Amount,Balance',
    '2025-05-01,Synthetic shop,-10.00,80.00',
    '2025-05-01,Synthetic shop,-10.00,70.00',
  ].join('\r\n'));
  expect(await importFile(overlap, main.id)).toMatchObject({ inserted: 1, duplicate: 1 });

  const noBalance = file('no-balance.csv', [
    'Date,Description,Amount',
    '2025-05-01,Synthetic shop,-10.00',
    '2025-05-02,Another shop,-20.00',
    '2025-05-02,Another shop,-20.00',
  ].join('\n'));
  const ambiguous = await preview(noBalance, main.id);
  expect(ambiguous.statement.counts).toMatchObject({ accepted: 1, duplicate: 2 });
  expect(ambiguous.statement.rows.at(-1)?.message).toContain('Possible duplicate skipped');
  expect(commitInput.safeParse({ token: ambiguous.token, version: ambiguous.statement.version,
    acceptRejected: false, decisions: { 2: 'keep' } }).success).toBe(false);
  expect(commit(ambiguous.token, ambiguous.statement)).toMatchObject({ inserted: 1, duplicate: 2 });
  const card = account('Card', 'credit-card');
  await expect(preview(original, card.id)).rejects.toThrow(/already been imported into another account/);
  expect(transactions()).toHaveLength(4);
});

it('imports corrected rejected rows without repeating accepted ones', async () => {
  const main = account();
  const partial = file('partial.csv', 'Date,Description,Amount\n2025-05-05,Valid,-10\n06/05/2025,Date repair,-2\n');
  const rejected = await preview(partial, main.id);
  expect(rejected.statement.counts.rejected).toBe(1);
  expect(commit(rejected.token, rejected.statement, true).inserted).toBe(1);
  const corrected = await preview(partial, main.id, { dateFormat: 'dmy' });
  expect(commit(corrected.token, corrected.statement).inserted).toBe(1);
  const card = account('Card', 'credit-card');
  expect((await importFile(fixture('absa-card.csv'), card.id, { dateFormat: 'dmy', decimal: ',' })).inserted).toBe(2);
  expect(transaction('Shop purchase').amount).toBe(-30000);
  expect(transactions()).toHaveLength(4);
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

it('keeps manual classifications and exact splits through bulk rules', async () => {
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
  expect(transactionDetail(db(), purchase.id).splits.map((line) => line.categoryId)).toEqual([grocery.id, other.id]);
  expect(() => previewCategoryDeletion(db(), other.id)).toThrow(/Archive it/);
  saveCategory(db(), { ...other, archived: true });
  expect(transactionDetail(db(), purchase.id).splits).toHaveLength(2);
  expect(listTransactions(db(), filters.parse({ text: 'Checkers' }))).toHaveLength(2);
});

it('deletes an unused category with exactly the linked rules confirmed by the user', () => {
  const fuel = category('Fuel');
  const { ruleIds } = previewCategoryDeletion(db(), fuel.id);
  expect(ruleIds.length).toBeGreaterThan(0);
  expect(() => deleteCategory(db(), { id: fuel.id, expectedRuleIds: [] })).toThrow(/linked rules changed/);
  expect(category('Fuel').id).toBe(fuel.id);
  const after = deleteCategory(db(), { id: fuel.id, expectedRuleIds: ruleIds });
  expect(after.some((row) => row.id === fuel.id)).toBe(false);
  expect(listRules(db()).some((rule) => rule.categoryId === fuel.id)).toBe(false);
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

it('uses imported history and preserves a closed budget revision after category edits', async () => {
  const main = account();
  await importFile(fixture('absa-current.csv'), main.id);
  const grocery = category('Supermarkets');
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

it('assigns budget actuals, rollover and reports to the configured payday cycle', async () => {
  const main = account();
  const groceries = category('Supermarkets').id;
  const statement = file('payday.csv', [
    'Date,Description,Amount',
    '20250524,Checkers previous,-1.00',
    '20250525,Checkers opens cycle,-20.00',
    '20250624,Checkers ends cycle,-30.00',
    '20250625,Checkers next cycle,-40.00',
  ].join('\n'));
  await importFile(statement, main.id);
  expect(store.state().active?.payDay).toBe(25);
  saveAllocation(db(), { month, categoryId: groceries, amount: 10000, rollover: true });
  const june = '2025-06';
  const allocation = saveAllocation(db(), { month: june, categoryId: groceries, amount: 5000, rollover: false });
  expect(allocation).toMatchObject({ start: '2025-05-25', end: '2025-06-24', actual: 5000, rollover: 9900 });
  expect(getBudget(db(), '2025-07').actual).toBe(4000);
  expect(recommend(db(), '2025-07').months).toEqual(['2025-05', june]);
  expect(report(db(), { month: june, period: 'month' })).toMatchObject({
    start: '2025-05-25', end: '2025-06-24', expense: 5000, budgetActual: 5000,
  });
  setClosed(db(), { month: june, closed: true });
  db().prepare('UPDATE profile SET pay_day=?').run(31);
  expect(getBudget(db(), june)).toMatchObject({
    start: '2025-05-25', end: '2025-06-24', actual: 5000, closed: true, changed: true,
  });
  expect(budgetPeriod('2024-03', 31)).toEqual({ start: '2024-02-29', end: '2024-03-30' });
  expect(budgetPeriod('2025-01', 1)).toEqual({ start: '2024-12-01', end: '2024-12-31' });
  expect(budgetMonth('2024-02-29', 31)).toBe('2024-03');
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
  expect(listTransactions(db(), filters.parse({}))).toHaveLength(50000);
}, 30000);

it('proposes AI categories and rules from redacted statements and writes only after confirmation', async () => {
  const main = account();
  const statement = file('ai.csv', [
    'Date,Description,Amount,Balance,Reference',
    '20250501,POS PURCHASE (EFFEC 30042025) SYNTHETIC COBBLER,-42.20,1050.00,PRIVATE-2038444',
    '20250501,POS PURCHASE (EFFEC 01052025) SYNTHETIC COBBLER,-31.80,1018.20,PRIVATE-7245772',
    '20250502,PRIVATE BAKERY REF 825210880,-20.00,998.20,PRIVATE-7024111',
    '20250502,MANUAL BAKERY,-10.00,988.20,PRIVATE-0928433',
  ].join('\n'));
  await importFile(statement, main.id);
  const manual = transactionDetail(db(), transaction('MANUAL BAKERY').id);
  saveTransaction(db(), { ...manual, confirmClassification: true });
  const key = 'sk-icash-synthetic-key';
  const outgoing: string[] = [];
  const client = new OpenAiClient(async (destination, init) => {
    expect(String(destination)).toMatch(/^https:\/\/api\.openai\.com\/v1\//);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + key);
    if (init?.method === 'GET') return Response.json({ id: 'gpt-4.1-mini' });
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(String(init?.body));
    expect(body.store).toBe(false);
    outgoing.push(body.input);
    const { samples, categories: choices } = JSON.parse(body.input) as {
      samples: { index: number; description: string }[];
      categories: { code: number; name: string }[];
    };
    const grocery = choices.find((choice) => choice.name.endsWith('/ Supermarkets'))!;
    const suggestions = samples.map((sample) => ({
      index: sample.index, category: sample.description.includes('BAKERY') ? grocery.code : null,
      newExpense: sample.description.includes('COBBLER') ? 'Shoe Repairs' : null, reason: 'Merchant type.',
      ...(body.text.format.name === 'icash_rules' ? { ruleName: 'Synthetic Cobbler', ruleMatch: 'SYNTHETIC COBBLER' } : {}),
    }));
    return Response.json({ status: 'completed', output: [{ type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify({ suggestions }) }] }] });
  });
  const ai = new AiCategorization(store, client);
  expect(ai.status().connected).toBe(false);
  await expect(ai.suggestTransaction(transaction('PRIVATE BAKERY REF 825210880').id)).rejects.toThrow(/Connect OpenAI/);
  await ai.connect(key);
  const profileId = active().id;
  expect(readFileSync(store.path(profileId, 'openai-key')).includes(key)).toBe(false);
  store.close();
  store.select(profileId);
  expect(ai.status()).toEqual({ connected: true });

  const bakery = transaction('PRIVATE BAKERY REF 825210880');
  const proposed = await ai.suggestTransaction(bakery.id);
  expect(proposed.category.name).toBe('Supermarkets');
  expect(transactionDetail(db(), bakery.id).categoryId).toBeNull();
  expect(outgoing[0]).toContain('PRIVATE BAKERY');
  expect(outgoing[0]).not.toMatch(/825210880|PRIVATE-7024111|2025-05|99820|2000|note|accountId/);
  expect(ai.applyTransaction(proposed.token).classification).toBe('manual');

  const cobbler = transaction('POS PURCHASE (EFFEC 30042025) SYNTHETIC COBBLER');
  const firstProposal = await ai.suggestTransaction(cobbler.id);
  expect(firstProposal.category).toMatchObject({ id: null, name: 'Shoe Repairs' });
  expect(categories(db()).some((entry) => entry.name === 'Shoe Repairs')).toBe(false);
  db().exec(`CREATE TRIGGER fail_ai_assignment BEFORE UPDATE OF category_id ON transactions
    BEGIN SELECT raise(ABORT, 'injected classification failure'); END;`);
  expect(() => ai.applyTransaction(firstProposal.token)).toThrow(/injected classification failure/);
  expect(categories(db()).some((entry) => entry.name === 'Shoe Repairs')).toBe(false);
  db().exec('DROP TRIGGER fail_ai_assignment');
  const saved = ai.applyTransaction(firstProposal.token);
  expect(saved.category).toBe('Shoe Repairs');
  expect(() => ai.applyTransaction(firstProposal.token)).toThrow(/new category suggestion/);

  const suggestions = await ai.suggestRules();
  expect(suggestions.rules).toHaveLength(1);
  expect(suggestions.rules[0]).toMatchObject({ name: 'Synthetic Cobbler', match: 'SYNTHETIC COBBLER', operator: 'contains',
    category: { id: saved.categoryId, name: 'Shoe Repairs' } });
  expect(transaction('POS PURCHASE (EFFEC 01052025) SYNTHETIC COBBLER').categoryId).toBeNull();
  const result = ai.applyRules(suggestions.token, [{ index: suggestions.rules[0]!.index, choice: 'suggested' }], true);
  expect(result).toMatchObject({ created: 1, classified: 1 });
  expect(result.rules).toContainEqual(expect.objectContaining({ name: 'Synthetic Cobbler',
    conditions: { field: 'description', operator: 'contains', text: 'SYNTHETIC COBBLER', direction: 'debit' } }));
  expect(transaction('MANUAL BAKERY').categoryId).toBeNull();
  expect((await ai.suggestRules()).rules).toHaveLength(0);
  expect(ai.disconnect().connected).toBe(false);
});

it('names AI rules and keeps a longer match when shortening would overlap another description', async () => {
  const payment = 'DIGITAL PAYMENT DT ABSA BANK TUIN';
  const restaurant = 'KFC STORMVOEL ROAD GAUTE CARD NO';
  const fee = 'TRANSACTION FEE DECL POS TRAN FEE (EFF:170926 AMT: 0,00 )';
  const otherFee = 'TRANSACTION FEE MONTHLY';
  const vet = 'FRY DIEREKLINIEK PRETO CARD NO';
  const shop = 'NORTH MARKET OLD TOWN CARD NO';
  const otherShop = 'NORTH MARKETPLACE';
  const overlapping = 'CENTRAL DEPOT';
  const overlapFee = 'CENTRAL DEPOT FEE';
  const main = account();
  const statement = file('ai-rules.csv', ['Date,Description,Amount',
    ...[payment, restaurant, fee, otherFee, vet, shop, otherShop, overlapping, overlapFee]
      .map((description) => `20250501,"${description}",-20.00`),
  ].join('\n'));
  await importFile(statement, main.id);
  const unrelated = transactionDetail(db(), transaction(otherShop).id);
  saveTransaction(db(), { ...unrelated, categoryId: category('Fuel').id, confirmClassification: true });
  const answers = new Map([
    [payment, { ruleName: 'Tuin', ruleMatch: 'TUIN' }],
    ['KFC STORMVOEL ROAD GAUTE', { ruleName: 'KFC', ruleMatch: 'KFC' }],
    ['TRANSACTION FEE DECL POS TRAN FEE', { ruleName: 'Transaction Fee Decl', ruleMatch: 'TRANSACTION FEE DECL' }],
    ['FRY DIEREKLINIEK PRETO', { ruleName: 'Fry Dierekliniek', ruleMatch: 'FRY DIEREKLINIEK' }],
    ['NORTH MARKET OLD TOWN', { ruleName: 'North Market', ruleMatch: 'NORTH MARKET' }],
    [overlapping, { ruleName: 'Central Depot', ruleMatch: overlapping }],
  ]);
  const ai = new AiCategorization(store, {
    async test() {},
    async suggest(_key, samples) {
      return samples.flatMap(({ index, description }) => {
        const answer = answers.get(description);
        return answer ? [{ index, ...answer, category: null, newExpense: 'Test Expenses', reason: '' }] : [];
      });
    },
  });
  await ai.connect('sk-icash-synthetic-key');
  const { token, rules } = await ai.suggestRules();
  expect(rules.map(({ name, match, operator }) => [name, match, operator])).toEqual(expect.arrayContaining([
    ['Tuin', 'TUIN', 'contains'],
    ['KFC', 'KFC', 'contains'],
    ['Transaction Fee Decl', 'TRANSACTION FEE DECL', 'contains'],
    ['Fry Dierekliniek', 'FRY DIEREKLINIEK', 'contains'],
    ['North Market', 'NORTH MARKET OLD TOWN', 'contains'],
  ]));
  expect(rules).toHaveLength(5);
  const saved = ai.applyRules(token, rules.map(({ index }) => ({ index, choice: 'suggested' })), true);
  expect(saved).toMatchObject({ created: 5, classified: 5 });
  expect(transaction(otherFee).categoryId).toBeNull();
  expect(transaction(otherShop).categoryId).toBe(category('Fuel').id);
  expect(transaction(overlapFee).categoryId).toBeNull();
  const laterFee = fee.replace('170926', '180926');
  await importFile(file('later.csv', `Date,Description,Amount\n20250502,"${laterFee}",-20.00`), main.id);
  expect(transaction(laterFee)).toMatchObject({ categoryId: category('Test Expenses').id, classification: 'rule' });
});

it('reviews a full statement in batches and proposes expenses for an empty household', async () => {
  store.create('Empty household', false);
  const bank = account();
  const merchants = Array.from('ABCDEFGHIJKLMNOPQRSTUVWX', (letter) => ['MARKET ' + letter, 'Supermarkets']);
  merchants.push(['OVERSEAS PURCHASE (EFFEC 02052025) MUSIC STREAM CARD NO. 4567', 'Streaming'],
    ['ACB DEBIT:EXTERNAL MOBILECO 12345678 PRIVATE34567', 'Mobile Phones'],
    ['SHOP 12345678 GARDEN SERVICE', 'Gardening']);
  const statement = file('empty-household.csv', ['Date,Description,Amount',
    ...merchants.map(([description]) => '20250502,' + description + ',-2.50'),
    '20250503,MARKET A,-5.50', '20250503,UNKNOWN CREDIT,5.00', '20250503,NOTIFYME,0.00',
  ].join('\n'));
  const { token, statement: previewed } = await preview(statement, bank.id);
  const rows = imports.uncategorized(db(), active().id, token, previewed.version);
  const sizes: number[] = [];
  const client = new OpenAiClient(async (_, init) => {
    if (init?.method === 'GET') return Response.json({});
    const body = JSON.parse(String(init?.body));
    const { samples, categories: choices } = JSON.parse(body.input) as {
      samples: { index: number; description: string }[]; categories: unknown[];
    };
    expect(choices).toEqual([]);
    expect(body.text.format.schema.properties.suggestions.items.properties.category).toEqual({ type: 'null' });
    expect(body.input).not.toMatch(/4567|02052025|UNKNOWN CREDIT|NOTIFYME/);
    expect(samples.map(({ index }) => index)).toEqual(samples.map((_, i) => i));
    sizes.push(samples.length);
    const suggestions = samples.map(({ index, description }) => {
      const category = description.startsWith('MARKET') ? 'Supermarkets' : ({
        'MUSIC STREAM': 'Streaming', 'ACB DEBIT EXTERNAL MOBILECO': 'Mobile Phones', 'SHOP GARDEN SERVICE': 'Gardening',
      } as Record<string, string>)[description];
      expect(category).toBeDefined();
      return { index, category: null, newExpense: category, newExpenseGroup: category === 'Gardening' ? 'House and garden' : null, reason: 'Spending purpose.',
        ruleName: category, ruleMatch: description };
    });
    return Response.json({ status: 'completed', output: [{ type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify({ suggestions }) }] }] });
  });
  const ai = new AiCategorization(store, client);
  await ai.connect('sk-icash-synthetic-key');
  const { suggestions } = await ai.suggestForRows(rows, true);
  expect(sizes).toEqual([24, 3]);
  const review = imports.setReview(db(), active().id, token, previewed.version, rows, suggestions);
  expect(review.pendingCategories).toBe(4);
  expect(categories(db())).toHaveLength(0);
  const version = previewed.version;
  expect(() => imports.reviewRules(db(), active().id, { token, version, changes: [] })).toThrow(/Categories page/);
  expect(() => imports.commit(db(), active().id, { token, version, acceptRejected: false })).toThrow(/Categories page/);
  const moderation = imports.moderation(active().id)!;
  expect(moderation.proposals.find((proposal) => proposal.name === 'Supermarkets')?.rows).toBe(25);
  for (const proposal of moderation.proposals) {
    const request = { token, version, proposalId: proposal.id };
    if (proposal.name === 'Gardening') {
      imports.moderateCategory(db(), active().id, { ...request, action: 'edit', edit: { group: proposal.group, name: 'Garden care' } });
    }
    imports.moderateCategory(db(), active().id, { ...request, action: proposal.name === 'Streaming' ? 'delete' : 'accept' });
  }
  const ready = imports.resume(db(), active().id)!;
  expect(ready.preview.review?.suggested).toBe(27);
  expect(transactions()).toHaveLength(0);
  const rules = imports.reviewRules(db(), active().id, { token, version, changes: [] });
  imports.commit(db(), active().id, { token, version, acceptRejected: false,
    review: { changes: [], ruleKeys: rules.map((rule) => rule.key) } });
  expect(categories(db()).filter((item) => item.parentId).map(({ name }) => name).sort()).toEqual(['Garden care', 'Mobile Phones', 'Supermarkets']);
  expect(category('Garden care').parentId).toBe(category('House and garden').id);
  expect(category('Supermarkets').parentId).toBe(category('Groceries').id);
  expect(transaction('SHOP 12345678 GARDEN SERVICE').categoryId).toBe(category('Garden care').id);
  expect(transaction('OVERSEAS PURCHASE (EFFEC 02052025) MUSIC STREAM CARD NO. 4567').categoryId).toBeNull();
  expect(listRules(db()).some((rule) => rule.categoryId === category('Garden care').id)).toBe(false);
});

it('rejects unsuccessful OpenAI responses without storing the failed key', async () => {
  const ai = new AiCategorization(store, new OpenAiClient(async () => new Response('ignored', { status: 401 })));
  await expect(ai.connect('sk-icash-synthetic-key')).rejects.toThrow(/rejected the API key/);
  expect(ai.status().connected).toBe(false);
});

it('uses matching rules before requesting or saving AI categories', async () => {
  const main = account();
  const card = account('Card', 'credit-card');
  const header = 'Date,Description,Amount,Balance\n';
  await importFile(file('main.csv', header + '20250501,Synthetic Bakery,-20.00,80.00'), main.id);
  await importFile(file('card.csv', header + '20250502,Synthetic Bakery,-21.00,79.00'), card.id);
  const groceries = category('Supermarkets');
  const conditions = { field: 'description', direction: 'debit' } as const;
  saveRule(db(), { name: 'Bakery on main', categoryId: groceries.id, priority: 1, enabled: true,
    conditions: { ...conditions, operator: 'contains', text: 'BAKERY', accountId: main.id } });
  const matched = transactions().find((row) => row.accountId === main.id)!;
  const unmatched = transactions().find((row) => row.accountId === card.id)!;
  const requests: number[] = [];
  const ai = new AiCategorization(store, {
    test: async () => {},
    suggest: async (_, samples) => {
      requests.push(samples.length);
      return samples.map(({ index }) => ({ index, category: null, newExpense: 'Bakery Visits', reason: '' }));
    },
  });

  const existing = await ai.suggestTransaction(matched.id);
  expect(existing.category.id).toBe(groceries.id);
  expect(requests).toEqual([]);
  expect(transactionDetail(db(), matched.id).categoryId).toBeNull();

  await ai.connect('sk-icash-synthetic-key');
  const rules = await ai.suggestRules();
  expect(rules.rules[0]?.samples).toBe(1);
  const matchingDraft = await ai.suggestTransaction(matched.id);
  expect(ai.applyTransaction(matchingDraft.token)).toMatchObject({ categoryId: groceries.id, classification: 'rule', rule: 'Bakery on main' });
  const draft = await ai.suggestTransaction(unmatched.id);
  expect(requests).toEqual([1, 1]);
  saveRule(db(), { name: 'Bakery across accounts', categoryId: groceries.id, priority: 2, enabled: true,
    conditions: { ...conditions, operator: 'equals', text: 'SYNTHETIC BAKERY' } });

  expect(() => ai.applyTransaction(draft.token)).toThrow(/matching rule changed/);
  expect(ai.applyRules(rules.token, [{ index: rules.rules[0]!.index, choice: 'suggested' }], true)).toMatchObject({ created: 0 });
  expect(categories(db()).some((entry) => entry.name === 'Bakery Visits')).toBe(false);
  expect((await ai.suggestRules()).rules).toHaveLength(0);
  expect(requests).toEqual([1, 1]);
});

it('reviews only new uncategorized statement rows and saves consistent overrides atomically', async () => {
  const main = account();
  const groceries = category('Supermarkets');
  const fuel = category('Fuel');
  const contents = [
    'Date,Description,Amount,Balance',
    '20250501,Checkers groceries,-10.00,90.00',
    '20250501,Synthetic shop Rivonia CARD NO,-20.00,70.00',
    '20250501,Synthetic shop Rivonia CARD NO,-20.00,50.00',
    '20250501,Synthetic shop Rivonia CARD NO,-20.00,50.00',
  ].join('\n');
  const selected = imports.selectBytes(db(), active().id, main.id, 'review.csv', Buffer.from(contents));
  const { token, suggested, delimiter, encoding, header } = selected;
  const statement = imports.preview(db(), active().id, token, mappingSchema.parse({ ...suggested, delimiter, encoding, header }));
  const rows = imports.uncategorized(db(), active().id, token, statement.version);
  expect(rows.map(({ row }) => row)).toEqual([3, 4]);
  const rule = {
    index: 0, name: 'Synthetic Shop', match: 'SYNTHETIC SHOP', sourceMatch: 'SYNTHETIC SHOP RIVONIA',
    operator: 'contains', direction: 'debit', samples: 2, reason: '',
    category: { id: fuel.id, label: fuel.name, name: fuel.name, kind: 'expense' },
  } as const;
  const reviewed = imports.setReview(db(), active().id, token, statement.version, rows,
    new Map([[reviewSample(rows[0]!).key, { category: rule.category, rule }]]));
  expect(reviewed.review?.suggested).toBe(2);
  const changes = [{ row: 3, choice: groceries.id }, { row: 4, choice: groceries.id }];
  const rules = imports.reviewRules(db(), active().id, { token, version: statement.version, changes });
  expect(rules).toHaveLength(1);
  const result = imports.commit(db(), active().id, { token, version: statement.version, acceptRejected: false,
    review: { changes, ruleKeys: rules.map((rule) => rule.key) } });
  expect(result).toMatchObject({ inserted: 3, duplicate: 1, rulesSaved: 1 });
  const shop = transactions().filter((row) => row.description === 'Synthetic shop Rivonia CARD NO');
  expect(shop.map((row) => row.categoryId)).toEqual([groceries.id, groceries.id]);
  expect(listRules(db()).find((rule) => rule.conditions.text === 'SYNTHETIC SHOP')).toMatchObject({
    categoryId: groceries.id, name: 'Synthetic Shop', conditions: { field: 'description', operator: 'contains' },
  });
});
