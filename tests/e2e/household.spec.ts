import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';

test('imports, corrects, budgets, restarts, and restores a household in Electron', async () => {
  const root = mkdtempSync(join(tmpdir(), 'icash-e2e-'));
  const backup = join(root, 'household.icash-backup');
  const ledgerExport = join(root, 'filtered-ledger.csv');
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
    const calendar = () => page.locator('.i-calendar-panel');
    const pickMonth = async (label: string, year: number, month: string, value: string) => {
      const field = page.getByLabel(label, { exact: true });
      const currentYear = Number((await field.inputValue()).slice(0, 4));
      await field.click();
      if (currentYear !== year) {
        await calendar().getByRole('button', { name: String(currentYear), exact: true }).click();
        const decade = Math.floor(year / 10) * 10;
        for (let shown = Math.floor(currentYear / 10) * 10; shown !== decade; shown += Math.sign(decade - shown) * 10) {
          const direction = shown > decade ? 'Previous' : 'Next';
          await calendar().locator('i-button[aria-label="' + direction + '"] button').click();
        }
        await calendar().getByRole('button', { name: String(year), exact: true }).click();
      }
      await calendar().getByRole('button', { name: month, exact: true }).click();
      await expect(field).toHaveValue(value);
    };
    const expandGroceries = async () => {
      const group = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Groceries', exact: true }) });
      await group.waitFor();
      const expand = group.getByRole('button', { name: 'Expand details' });
      if (await expand.count()) await expand.click();
    };
    await page.getByLabel('Household name').fill('Synthetic household');
    await page.getByRole('button', { name: 'Create household' }).click();
    await page.locator('i-table .i-table-header').getByRole('button', { name: 'Add account' }).click();
    await page.getByLabel('Account name').fill('Absa current');
    await page.getByRole('button', { name: 'Save account' }).click();
    await expect(page.getByText('Account saved.')).toBeVisible();

    await nav('Import statements');
    const fileInput = page.locator('i-file-upload input[type=file]');
    await expect(fileInput).toBeEnabled();
    const drop = await page.evaluateHandle((contents) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([contents], 'absa-current.csv', { type: 'text/csv' }));
      return transfer;
    }, readFileSync(fixture, 'utf8'));
    await page.locator('i-file-upload .i-file-upload__drop-zone').dispatchEvent('drop', { dataTransfer: drop });
    await drop.dispose();
    await page.getByRole('button', { name: 'Validate statement' }).click();
    await expect(page.getByText(/5 ready/)).toBeVisible();
    await page.getByRole('dialog', { name: 'Review import categories' })
      .getByRole('button', { name: 'Import transactions', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: /5 added/ })).toBeVisible();

    await fileInput.setInputFiles(fixture);
    await page.getByRole('button', { name: 'Validate statement' }).click();
    await expect(page.getByText(/5 duplicates skipped/)).toBeVisible();
    await page.getByRole('button', { name: 'Import new rows' }).click();
    await expect(page.getByRole('status').filter({ hasText: /0 added, 5 duplicates/ })).toBeVisible();

    await nav('Transactions');
    const ledger = page.locator('icash-transactions i-table').first();
    const rows = ledger.locator('cdk-virtual-scroll-viewport .i-table-virtual-row');
    await expect(rows.first()).toContainText('Transfer to savings');
    await ledger.getByText('Posting date', { exact: true }).click();
    await expect(rows.first()).toContainText('Salary');
    const search = ledger.getByRole('textbox', { name: 'Search table' });
    await search.fill('Checkers refund');
    await expect(rows).toHaveCount(1);
    await app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    }, ledgerExport);
    await page.getByRole('button', { name: 'Export results' }).click();
    await expect(page.getByText('Ledger exported.')).toBeVisible();
    const exported = readFileSync(ledgerExport, 'utf8');
    expect(exported).toContain('Checkers refund');
    expect(exported).not.toContain('Checkers groceries');
    await page.getByRole('button', { name: 'Review Checkers refund' }).click();
    const review = page.getByRole('dialog', { name: 'Edit transaction' });
    await expect(review).toBeVisible();
    await choose(review, 'Treatment', 'Expense / refund');
    await choose(review, 'Transaction category', 'Groceries / Supermarkets');
    await page.getByRole('button', { name: 'Save transaction' }).click();
    await expect(page.getByText('Transaction saved.')).toBeVisible();

    await nav('Budgets');
    await pickMonth('Budget month', 2025, 'May', '2025-05');
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
    await pickMonth('Report month', 2025, 'Jun', '2025-06');
    await expect(page.getByText('2025-05-25 to 2025-06-24')).toBeVisible();
    await pickMonth('Report month', 2025, 'May', '2025-05');
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
    await pickMonth('Budget month', 2025, 'May', '2025-05');
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

    await nav('Rules');
    await expect(page.locator('.page-header').getByRole('button', { name: 'Suggest rules with AI' })).toBeVisible();
    await page.locator('icash-rules i-table').getByRole('button', { name: /^Edit / }).first().click();
    const editRule = page.getByRole('dialog', { name: 'Edit rule' });
    await expect(editRule).toBeVisible();
    await editRule.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('i-table .i-table-header').getByRole('button', { name: 'New rule' }).click();
    await expect(page.getByRole('dialog', { name: 'New rule' })).toBeVisible();
    await page.keyboard.press('Escape');
    await nav('Categories');
    await page.locator('i-table .i-table-header').getByRole('button', { name: 'New category' }).click();
    const newCategory = page.getByRole('dialog', { name: 'New category' });
    await newCategory.getByLabel('Category name').fill('Test supermarket');
    await expect(newCategory.getByRole('button', { name: 'Save category' })).toBeDisabled();
    await choose(newCategory, 'Category group', 'Groceries');
    await newCategory.getByRole('button', { name: 'Save category' }).click();
    await expect(newCategory).toHaveCount(0);

    await nav('Savings goals');
    await page.getByLabel('Goal name').fill('Emergency fund');
    await page.getByLabel('Target amount (R)').fill('1000.00');
    const cell = () => page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Emergency fund', exact: true }) });
    const pickDay = async (label: string) => {
      const field = page.getByLabel(label, { exact: true });
      await field.click();
      await calendar().getByRole('button', { name: '15', exact: true }).click();
      await expect(field).toHaveValue(/^\d{4}-\d{2}-15$/);
      return field.inputValue();
    };
    const due = await pickDay('Target date');
    await page.getByRole('button', { name: 'Save goal' }).click();
    await expect(cell()).toContainText(due);
    await nav('Overview');
    await nav('Savings goals');
    await cell().getByRole('button', { name: 'Edit Emergency fund' }).click();
    await expect(page.getByLabel('Target date', { exact: true })).toHaveValue(due);
    await page.getByRole('button', { name: 'Clear target date' }).click();
    await expect(page.getByLabel('Target date', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Save goal' }).click();
    await expect(page.getByText('Savings goal saved.')).toBeVisible();
    await expect(cell()).not.toContainText(due);
    await cell().getByRole('button', { name: 'Record movement for Emergency fund' }).click();
    await page.getByLabel('Signed amount (R)').fill('100.00');
    const entry = await pickDay('Entry date');
    await page.getByRole('button', { name: 'Record movement', exact: true }).click();
    await expect(page.getByText('Savings movement recorded.')).toBeVisible();
    await cell().getByRole('button', { name: 'Expand details' }).click();
    await expect(page.getByRole('cell', { name: entry, exact: true })).toBeVisible();

    await nav('Settings');
    await page.getByLabel('Payday (1–31)', { exact: true }).fill('25');
    await page.getByRole('button', { name: 'Save payday' }).click();
    await expect(page.getByText('Payday saved.')).toBeVisible();
    await nav('Budgets');
    await pickMonth('Budget month', 2025, 'Jun', '2025-06');
    await expect(page.getByText('Budget period 2025-05-25 to 2025-06-24')).toBeVisible();
    await page.getByRole('button', { name: 'Review spending for Uncategorized' }).click();
    await expect(page.getByText('Budget contributors')).toBeVisible();
    const history = page.getByRole('group', { name: 'Page history' });
    await history.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'Monthly budgets' })).toBeVisible();
    await history.getByRole('button', { name: 'Forward' }).click();
    await expect(page.getByText('Budget contributors')).toBeVisible();
    await expect(page.getByText('2025-05-25 to 2025-06-24')).toBeVisible();
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
    '20250503,Synthetic Market,-10.00,20.00',
  ].join('\n'));
  const app = await electron.launch({
    args: ['.', ...(process.env.ICASH_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
    env: { ...process.env, ICASH_TEST_DATA: join(root, 'user-data') },
  });
  try {
    await app.evaluate(() => {
      globalThis.fetch = async (url, options) => {
        if (!String(url).startsWith('https://api.openai.com/v1/')) throw new Error('Unexpected network request');
        if (options?.method === 'GET') return Response.json({ id: 'gpt-4.1-mini' });
        const body = JSON.parse(String(options?.body));
        const { samples } = JSON.parse(body.input) as {
          samples: { index: number; description: string }[];
        };
        const suggestions = samples.map((sample) => ({
          index: sample.index, category: null, reason: 'Merchant type.',
          newExpense: sample.description.includes('BAKERY') ? 'Bakery Visits' : sample.description.includes('MARKET') ? 'Market Shopping' : 'Shoe Repairs',
          ...(body.text.format.name === 'icash_rules' ? {
            ruleName: sample.description.includes('COBBLER') ? 'Synthetic Cobbler' : null, ruleMatch: sample.description,
          } : {}),
        }));
        return Response.json({ status: 'completed', output: [{ type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify({ suggestions }) }] }] });
      };
    });
    const page = await app.firstWindow();
    const nav = (name: string) => page.locator('i-menu').getByRole('link', { name: new RegExp(name + '$') }).click();
    await page.getByLabel('Household name').fill('Synthetic OpenAI household');
    await page.getByRole('button', { name: 'Create household' }).click();
    await page.locator('i-table .i-table-header').getByRole('button', { name: 'Add account' }).click();
    await page.getByLabel('Account name').fill('Synthetic account');
    await page.getByRole('button', { name: 'Save account' }).click();
    await expect(page.getByText('Account saved.')).toBeVisible();
    await nav('Settings');
    await page.getByRole('tab', { name: /OpenAI/ }).click();
    await page.getByLabel('OpenAI API key').fill('sk-icash-synthetic-key');
    await page.getByRole('button', { name: 'Verify and connect' }).click();
    await expect(page.getByText('OpenAI connection verified.')).toBeVisible();
    await expect(page.getByLabel('OpenAI API key')).toHaveValue('');

    await nav('Import statements');
    const fileInput = page.locator('i-file-upload input[type=file]');
    await expect(fileInput).toBeEnabled();
    await fileInput.setInputFiles(statement);
    await page.getByRole('button', { name: 'Validate statement' }).click();
    const next = page.getByRole('button', { name: 'Continue to rule assignments' });
    await expect(next).toBeDisabled();
    await page.getByRole('button', { name: 'Delete proposal for Bakery Visits' }).click();
    await page.getByRole('button', { name: 'Edit proposal for Shoe Repairs' }).click();
    const proposal = page.getByRole('dialog', { name: 'Edit proposed category' });
    await proposal.getByLabel('Category name').fill('Shoe and Bag Repairs');
    await proposal.getByRole('button', { name: 'Save proposal' }).click();
    await page.getByRole('button', { name: 'Accept Shoe and Bag Repairs' }).click();
    await page.getByRole('button', { name: 'Accept Market Shopping' }).click();
    await next.click();
    const importReview = page.getByRole('dialog', { name: 'Review import categories' });
    await expect(importReview).toContainText('2 AI suggestions');
    await expect(importReview.getByText('Miscellaneous / Shoe and Bag Repairs')).toBeVisible();
    await importReview.getByRole('button', { name: 'Review rules' }).click();
    const importRules = page.getByRole('dialog', { name: 'Review import rules' });
    await expect(importRules.getByText('Miscellaneous / Shoe and Bag Repairs')).toBeVisible();
    await importRules.getByRole('button', { name: 'Change rule category for Synthetic Market' }).click();
    await importRules.getByRole('button', { name: /^Category for Synthetic Market:/ }).click();
    await page.getByRole('option', { name: 'Groceries / Supermarkets', exact: true }).click();
    await importRules.getByRole('button', { name: 'Skip Synthetic Market' }).click();
    await importRules.getByRole('button', { name: 'Import and save selected rules' }).click();
    await expect(page.getByText(/Saved 1 rule/)).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /3 added/ })).toBeVisible();

    await nav('Transactions');
    await expect(page.locator('i-table .i-table-virtual-row').filter({ hasText: 'Synthetic Market' })).toContainText('Supermarkets');
    const ai = page.getByRole('button', { name: 'AI classify Synthetic Bakery' });
    const confirmation = page.getByRole('dialog', { name: 'Confirm AI classification' });
    const bakery = page.locator('i-table .i-table-virtual-row').filter({ has: ai });
    await ai.click();
    await expect(confirmation.getByText(/Bakery Visits$/)).toBeVisible();
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(bakery).toContainText('Uncategorized');
    await ai.click();
    await confirmation.getByRole('button', { name: 'Create category and apply' }).click();
    await expect(bakery).toContainText('Bakery Visits');

    await nav('Rules');
    await expect(page.getByText('Synthetic Cobbler', { exact: true })).toBeVisible();
    await expect(page.getByText('Miscellaneous / Shoe and Bag Repairs', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit Synthetic Cobbler' }).click();
    const editRule = page.getByRole('dialog', { name: 'Edit rule' });
    await editRule.getByRole('button', { name: /^Target category:/ }).click();
    await page.getByRole('option', { name: 'Family / Pets', exact: true }).click();
    await editRule.getByRole('button', { name: 'Save rule' }).click();
    await expect(page.getByText('Rule saved.')).toBeVisible();

    await page.getByRole('button', { name: 'Preview rule changes' }).click();
    const apply = page.locator('i-card').filter({ has: page.getByRole('heading', { name: 'Apply to previous transactions' }) });
    const comparison = apply.locator('.i-table-virtual-row').filter({ hasText: 'Synthetic Cobbler' });
    await expect(comparison).toContainText('Miscellaneous / Shoe and Bag Repairs');
    await expect(comparison).toContainText('Family / Pets');
    await apply.getByRole('button', { name: 'Apply reviewed changes' }).click();
    await expect(page.getByText('Updated 1 transaction.')).toBeVisible();
    await nav('Transactions');
    const classifyCobbler = page.getByRole('button', { name: 'AI classify Synthetic Cobbler' });
    const cobbler = page.locator('i-table .i-table-virtual-row').filter({ has: classifyCobbler });
    await expect(cobbler).toContainText('Pets');
    await classifyCobbler.click();
    const existingRule = page.getByRole('dialog', { name: 'Apply existing rule' });
    await expect(existingRule.getByText('Family / Pets', { exact: true })).toBeVisible();
    await existingRule.getByRole('button', { name: 'Apply classification' }).click();
    await expect(page.getByText('Existing rule applied.')).toBeVisible();

    await nav('Categories');
    const miscellaneous = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Miscellaneous', exact: true }) });
    await miscellaneous.getByRole('button', { name: 'Expand details' }).click();
    await page.getByRole('button', { name: 'Archive Market Shopping' }).click();
    await expect(page.getByText('Category archived.')).toBeVisible();
    const expandMiscellaneous = miscellaneous.getByRole('button', { name: 'Expand details' });
    if (await expandMiscellaneous.count()) await expandMiscellaneous.click();
    await expect(page.getByRole('button', { name: 'Restore Market Shopping' })).toBeVisible();
    const transport = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Transport', exact: true }) });
    await transport.getByRole('button', { name: 'Expand details' }).click();
    await page.getByRole('button', { name: 'Delete Fuel', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: 'Confirm action' });
    await expect(deletion).toContainText('linked rules');
    await deletion.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText('Category deleted.')).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
