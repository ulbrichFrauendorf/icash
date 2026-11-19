import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';

test('imports, corrects, budgets, restarts, and restores a household in Electron', async () => {
  const root = mkdtempSync(join(tmpdir(), 'icash-e2e-'));
  const backup = join(root, 'household.icash-backup');
  const fixture = resolve('tests/fixtures/absa-current.csv');
  const start = () => electron.launch({
    args: ['.', ...(process.env.ICASH_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
    env: { ...process.env, ICASH_TEST_DATA: join(root, 'user-data') },
  });
  let app = await start();
  try {
    let page = await app.firstWindow();
    const nav = (name: string) => page.locator('i-menu').getByRole('link', { name: new RegExp(name + '$') }).click();
    const choose = async (scope: Page | Locator, label: string, option: string) => {
      await scope.getByRole('button', { name: new RegExp('^' + label + ':') }).click();
      await page.getByRole('option', { name: option, exact: true }).click();
    };
    const expandGroceries = async () => {
      const group = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Groceries', exact: true }) });
      await group.waitFor();
      const expand = group.getByRole('button', { name: 'Expand details' });
      if (await expand.count()) await expand.click();
    };
    await page.getByLabel('Household name').fill('Synthetic household');
    await page.getByRole('button', { name: 'Create household' }).click();
    await page.getByLabel('Account name').fill('Absa current');
    await page.getByRole('button', { name: 'Save account' }).click();
    await expect(page.getByText('Account saved.')).toBeVisible();

    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, fixture);
    await nav('Import statements');
    await page.getByRole('button', { name: 'Choose CSV' }).click();
    await page.getByRole('button', { name: 'Validate statement' }).click();
    await expect(page.getByText(/5 ready/)).toBeVisible();
    await page.getByRole('button', { name: 'Import new rows' }).click();
    await expect(page.getByRole('status').filter({ hasText: /5 added/ })).toBeVisible();

    await page.getByRole('button', { name: 'Choose CSV' }).click();
    await page.getByRole('button', { name: 'Validate statement' }).click();
    await expect(page.getByText(/5 duplicates skipped/)).toBeVisible();
    await page.getByRole('button', { name: 'Import new rows' }).click();
    await expect(page.getByRole('status').filter({ hasText: /0 added, 5 duplicates/ })).toBeVisible();

    await nav('Transactions');
    await page.getByRole('button', { name: 'Review Checkers refund' }).click();
    const review = page.getByRole('dialog', { name: 'Edit transaction' });
    await expect(review).toBeVisible();
    await choose(review, 'Treatment', 'Expense / refund');
    await choose(review, 'Transaction category', 'Groceries / Supermarkets');
    await page.getByRole('button', { name: 'Save transaction' }).click();
    await expect(page.getByText('Transaction saved.')).toBeVisible();

    await nav('Budgets');
    await page.getByLabel('Budget month').fill('2025-05');
    await expandGroceries();
    await page.getByRole('button', { name: 'Edit allocation for Supermarkets' }).click();
    await page.getByLabel('Budget amount (R)').fill('2000.00');
    await page.getByRole('button', { name: 'Save allocation' }).click();
    const supermarkets = () => page.getByRole('row', { name: /^Supermarkets / });
    await expandGroceries();
    await expect(supermarkets()).toContainText('420,00');
    await expect(supermarkets()).toContainText(/1\s?580,00/);

    await page.getByRole('button', { name: 'Use dark theme' }).click();
    await expect(page.locator('body')).toHaveClass('dark');
    await expect(page.getByRole('img', { name: 'iCash logo' })).toHaveAttribute('src', /invensys-icon-dark/);

    await nav('Overview');
    await expect(page.getByTestId('income')).toContainText(/10\s?000,00/);
    await expect(page.getByRole('img', { name: 'Bar chart of monthly income and spending' })).toBeVisible();

    await nav('Settings');
    await page.getByRole('tab', { name: /Backup and recovery/ }).click();
    await app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    }, backup);
    await page.getByLabel('Backup passphrase').fill('synthetic passphrase');
    await page.getByRole('button', { name: 'Export backup' }).click();
    await expect(page.getByText('Encrypted backup saved.')).toBeVisible();
    await app.close();
    app = await start();
    page = await app.firstWindow();
    await expect(page.getByText('Synthetic household')).toBeVisible();
    await expect(page.locator('body')).toHaveClass('dark');
    await nav('Budgets');
    await page.getByLabel('Budget month').fill('2025-05');
    await expandGroceries();
    await expect(supermarkets()).toContainText(/1\s?580,00/);

    await nav('Settings');
    await page.getByRole('tab', { name: /Backup and recovery/ }).click();
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, backup);
    await page.getByLabel('Backup passphrase').fill('synthetic passphrase');
    await page.getByRole('button', { name: 'Restore as a new household' }).click();
    await expect(page.getByText('Backup restored as a new household.')).toBeVisible();
    await nav('Budgets');
    await expandGroceries();
    await expect(supermarkets()).toContainText(/1\s?580,00/);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reviews OpenAI classifications and imported rules before saving', async () => {
  const root = mkdtempSync(join(tmpdir(), 'icash-ai-e2e-'));
  const statement = join(root, 'statement.csv');
  writeFileSync(statement, [
    'Date,Description,Amount,Balance',
    '20250501,Synthetic Bakery,-40.00,50.00',
    '20250502,Synthetic Cobbler,-20.00,30.00',
  ].join('\n'));
  const app = await electron.launch({
    args: ['.', ...(process.env.ICASH_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
    env: { ...process.env, ICASH_TEST_DATA: join(root, 'user-data') },
  });
  try {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      globalThis.fetch = async (url, options) => {
        if (!String(url).startsWith('https://api.openai.com/v1/')) throw new Error('Unexpected network request');
        if (options?.method === 'GET') return Response.json({ id: 'gpt-4.1-mini' });
        const { samples } = JSON.parse(JSON.parse(String(options?.body)).input) as {
          samples: { index: number; description: string }[];
        };
        const suggestions = samples.map((sample) => ({
          index: sample.index, category: null, reason: 'Merchant type.',
          newExpense: sample.description.includes('BAKERY') ? 'Bakery Visits' : 'Shoe Repairs',
        }));
        return Response.json({ status: 'completed', output: [{ type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify({ suggestions }) }] }] });
      };
    }, statement);
    const page = await app.firstWindow();
    const nav = (name: string) => page.locator('i-menu').getByRole('link', { name: new RegExp(name + '$') }).click();
    await page.getByLabel('Household name').fill('Synthetic OpenAI household');
    await page.getByRole('button', { name: 'Create household' }).click();
    await page.getByLabel('Account name').fill('Synthetic account');
    await page.getByRole('button', { name: 'Save account' }).click();
    await expect(page.getByText('Account saved.')).toBeVisible();
    await nav('Import statements');
    await page.getByRole('button', { name: 'Choose CSV' }).click();
    await page.getByRole('button', { name: 'Validate statement' }).click();
    await page.getByRole('button', { name: 'Import new rows' }).click();
    await expect(page.getByRole('status').filter({ hasText: /2 added/ })).toBeVisible();

    await nav('Settings');
    await page.getByRole('tab', { name: /OpenAI/ }).click();
    await page.getByLabel('OpenAI API key').fill('sk-icash-synthetic-key');
    await page.getByRole('button', { name: 'Verify and connect' }).click();
    await expect(page.getByText('OpenAI connection verified.')).toBeVisible();
    await expect(page.getByLabel('OpenAI API key')).toHaveValue('');

    await nav('Transactions');
    const ai = page.getByRole('button', { name: 'AI classify Synthetic Bakery' });
    const confirmation = page.getByRole('dialog', { name: 'Confirm AI classification' });
    const bakery = page.locator('i-table .i-table-virtual-row').filter({ has: ai });
    await ai.click();
    await expect(confirmation.getByText('Bakery Visits', { exact: true })).toBeVisible();
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(bakery).toContainText('Uncategorized');
    await ai.click();
    await confirmation.getByRole('button', { name: 'Create category and apply' }).click();
    await expect(bakery).toContainText('Bakery Visits');

    await nav('Rules');
    await page.getByRole('button', { name: 'Suggest rules with AI' }).click();
    const rules = page.getByRole('dialog', { name: 'Review AI rule suggestions' });
    await expect(rules).toContainText('Create expense category Shoe Repairs');
    await rules.getByRole('checkbox', { name: /Exactly matches SYNTHETIC COBBLER/ }).click();
    await rules.getByRole('button', { name: 'Save selected rules' }).click();
    await expect(page.getByText('Saved 1 rule and categorized 1 imported transaction.')).toBeVisible();
    await nav('Transactions');
    const cobbler = page.locator('i-table .i-table-virtual-row').filter({
      has: page.getByRole('button', { name: 'AI classify Synthetic Cobbler' }),
    });
    await expect(cobbler).toContainText('Shoe Repairs');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
