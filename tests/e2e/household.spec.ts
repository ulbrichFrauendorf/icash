import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

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
    const nav = (name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
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
    await page.getByLabel('Date format').selectOption('ymd');
    await page.getByLabel('Decimal separator').selectOption('.');
    await page.getByRole('button', { name: 'Validate statement' }).click();
    await expect(page.getByText(/5 ready/)).toBeVisible();
    await page.getByRole('button', { name: 'Import reviewed rows' }).click();
    await expect(page.getByRole('status').filter({ hasText: /5 added/ })).toBeVisible();

    await nav('Transactions');
    await page.getByRole('button', { name: 'Review Checkers refund' }).click();
    const review = page.locator('#transaction-review');
    await review.getByLabel('Treatment', { exact: true }).selectOption('expense');
    await review.getByLabel('Transaction category').selectOption({ label: 'Groceries / Supermarkets' });
    await page.getByRole('button', { name: 'Save transaction' }).click();
    await expect(page.getByText('Transaction saved.')).toBeVisible();

    await nav('Budgets');
    await page.getByLabel('Budget month').fill('2025-05');
    await page.getByRole('button', { name: 'Edit allocation for Supermarkets' }).click();
    await page.getByLabel('Budget amount (R)').fill('2000.00');
    await page.getByRole('button', { name: 'Save allocation' }).click();
    const supermarkets = () => page.getByRole('row').filter({ hasText: 'Supermarkets' });
    await expect(supermarkets()).toContainText('420,00');
    await expect(supermarkets()).toContainText(/1\s?580,00/);

    await nav('Settings');
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
    await nav('Budgets');
    await page.getByLabel('Budget month').fill('2025-05');
    await expect(supermarkets()).toContainText(/1\s?580,00/);

    await nav('Settings');
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, backup);
    await page.getByLabel('Backup passphrase').fill('synthetic passphrase');
    await page.getByRole('button', { name: 'Restore as a new household' }).click();
    await expect(page.getByText('Backup restored as a new household.')).toBeVisible();
    await nav('Budgets');
    await expect(supermarkets()).toContainText(/1\s?580,00/);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
