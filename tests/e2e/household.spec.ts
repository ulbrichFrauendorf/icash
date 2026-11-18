import { mkdtempSync, rmSync } from 'node:fs';
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
    const review = page.locator('#transaction-review');
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
