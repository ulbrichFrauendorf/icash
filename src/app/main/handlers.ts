import { ipcMain, dialog, type BrowserWindow } from 'electron';
import { open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { accounts, saveAccount } from '../../features/accounts/main';
import { saveAccountInput } from '../../features/accounts/contract';
import { exportBackup, restoreBackup } from '../../features/backup-restore/main';
import { categories, deleteCategory, previewCategoryDeletion, restoreDefaults, saveCategory } from '../../features/categories/main';
import { deleteCategoryInput, saveCategoryInput } from '../../features/categories/contract';
import { portableTemplate, Templates } from '../../features/categories/portable';
import { merchantInput, rulePreview, saveRuleInput } from '../../features/categorization/contract';
import { listRules, recategorize, saveMerchant, saveRule } from '../../features/categorization/main';
import { commitInput, decodeInput, importRulesInput, moderateCategoryInput, previewInput, selectImportInput } from '../../features/import-statement/contract';
import { auditRows, batches, Imports } from '../../features/import-statement/main';
import { allocationInput, closeInput, copyInput, defaultInput, monthInput } from '../../features/monthly-budget/contract';
import { copyBudget, getBudget, recommend, saveAllocation, saveDefault, setClosed } from '../../features/monthly-budget/main';
import { createProfileInput, payDayInput, profileIdInput, selectThemeInput } from '../../features/profiles/contract';
import type { ProfileStore } from '../../features/profiles/main';
import { reportInput } from '../../features/reports/contract';
import { csv, numericCsv, report } from '../../features/reports/main';
import { entryInput, goalInput } from '../../features/savings-goals/contract';
import { goals, goalTransfers, removeEntry, saveEntry, saveGoal } from '../../features/savings-goals/main';
import { exportTransactionsInput, filters, transactionInput } from '../../features/transactions/contract';
import { listTransactions, saveTransaction, transactionDetail } from '../../features/transactions/main';
import { applyAiRulesInput, openAiKeyInput } from '../../features/openai/contract';
import { AiCategorization } from '../../features/openai/main';
import { candidateInput, pairInput } from '../../features/transfers/contract';
import { pairTransfer, transferCandidates, unlinkTransfer } from '../../features/transfers/main';
import type { IpcResult, Requests } from '../../shared/api';
import { empty, UserError } from '../../shared/schema';

const passphrase = z.object({ passphrase: z.string().min(12, 'Use a backup passphrase of at least 12 characters.').max(256) });

export function registerHandlers(profiles: ProfileStore, window: () => BrowserWindow | null, appUrl: string, dataRoot: string) {
  const imports = new Imports();
  const templates = new Templates();
  const ai = new AiCategorization(profiles);
  const active = () => profiles.active();
  const db = () => active().db;

  function handle<K extends keyof Requests, Schema extends z.ZodType>(
    key: K, schema: Schema, operation: (input: z.output<Schema>) => Requests[K][1] | Promise<Requests[K][1]>,
  ) {
    ipcMain.handle('icash:' + key, async (event, payload: unknown): Promise<IpcResult<Requests[K][1]>> => {
      const owner = window();
      const sender = event.senderFrame;
      if (!owner || event.sender !== owner.webContents || !sender || sender !== event.sender.mainFrame ||
          sender.url.split(/[?#]/)[0] !== appUrl) return { ok: false, error: 'Unexpected application window.' };
      const parsed = schema.safeParse(payload);
      if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
      try { return { ok: true, data: await operation(parsed.data) }; }
      catch (error) {
        if (error instanceof UserError) return { ok: false, error: error.message };
        // System error text can contain paths, SQL bindings, and financial information.
        console.error('iCash operation failed', key);
        return { ok: false, error: 'iCash could not complete this action. Check that the profile and selected file are accessible.' };
      }
    });
  }

  async function pick(title: string, extensions: string[]) {
    const owner = window();
    if (!owner) return null;
    const result = await dialog.showOpenDialog(owner, { title, filters: [{ name: title, extensions }], properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }

  async function savePath(title: string, suggested: string) {
    const owner = window();
    if (!owner) return null;
    const result = await dialog.showSaveDialog(owner, { title, defaultPath: suggested });
    if (result.canceled || !result.filePath) return null;
    const target = resolve(await realpath(dirname(result.filePath)), relative(dirname(result.filePath), result.filePath));
    const root = await realpath(dataRoot);
    const between = relative(root, target);
    if (between !== '..' && !between.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(between)) throw new UserError('Choose a location outside the iCash data folder.');
    return target;
  }

  async function saveText(title: string, suggested: string, generate: () => string) {
    const current = active().id;
    const destination = await savePath(title, suggested);
    if (!destination) return false;
    if (active().id !== current) throw new UserError('The active profile changed. Try the export again.');
    const temporary = destination + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, generate(), { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
    return true;
  }

  function changeProfile<T>(operation: () => T): T {
    imports.clear();
    templates.clear();
    ai.clear();
    return operation();
  }

  handle('openAiStatus', empty, () => ai.status());
  handle('connectOpenAi', openAiKeyInput, ({ key }) => ai.connect(key));
  handle('disconnectOpenAi', empty, () => ai.disconnect());
  handle('suggestAiCategory', profileIdInput, ({ id }) => ai.suggestTransaction(id));
  handle('applyAiCategory', profileIdInput, ({ id }) => ai.applyTransaction(id));
  handle('suggestAiRules', empty, () => ai.suggestRules());
  handle('applyAiRules', applyAiRulesInput, ({ token, selected, applyToImported }) => ai.applyRules(token, selected, applyToImported));

  handle('getProfiles', empty, () => profiles.state());
  handle('createProfile', createProfileInput, (input) => changeProfile(() => profiles.create(input.name, input.seed)));
  handle('selectProfile', profileIdInput, ({ id }) => changeProfile(() => profiles.select(id)));
  handle('deleteProfile', profileIdInput, ({ id }) => changeProfile(() => profiles.remove(id)));
  handle('setTheme', selectThemeInput, ({ theme }) => {
    db().prepare('UPDATE profile SET theme=?').run(theme);
    return profiles.state();
  });
  handle('setPayDay', payDayInput, ({ payDay }) => {
    db().prepare('UPDATE profile SET pay_day=?').run(payDay);
    return profiles.state();
  });
  handle('accounts', empty, () => accounts(db()));
  handle('saveAccount', saveAccountInput, (input) => saveAccount(db(), input));
  handle('categories', empty, () => categories(db()));
  handle('saveCategory', saveCategoryInput, (input) => saveCategory(db(), input));
  handle('previewCategoryDeletion', profileIdInput, ({ id }) => previewCategoryDeletion(db(), id));
  handle('deleteCategory', deleteCategoryInput, (input) => deleteCategory(db(), input));
  handle('restoreDefaults', empty, () => restoreDefaults(db()));
  handle('exportTemplate', empty, () => saveText('Export category template', 'icash-categories.json', () => JSON.stringify(portableTemplate(db()), null, 2)));
  handle('previewTemplate', empty, async () => {
    const profile = active();
    const file = await pick('Import category template', ['json']);
    if (!file) return null;
    const handle = await open(file, 'r');
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > 1024 * 1024) throw new UserError('Choose a category template smaller than 1 MiB.');
      const buffer = Buffer.alloc(stats.size + 1);
      const read = await handle.read(buffer, { offset: 0, length: buffer.length, position: 0 });
      if (read.bytesRead !== stats.size) throw new UserError('The template changed while being read.');
      if (active().id !== profile.id) throw new UserError('The active profile changed.');
      return templates.preview(profile.db, profile.id, buffer.subarray(0, read.bytesRead).toString('utf8'));
    } finally { await handle.close(); }
  });
  handle('commitTemplate', profileIdInput, ({ id }) => templates.commit(db(), active().id, id));
  handle('selectImport', selectImportInput, ({ id, name, bytes }) => imports.selectBytes(db(), active().id, id, name, bytes));
  handle('decodeImport', decodeInput, (input) => imports.decode(db(), active().id, input));
  handle('previewImport', previewInput, async ({ token, mapping }) => {
    const profile = active();
    const preview = imports.preview(profile.db, profile.id, token, mapping);
    const rows = imports.uncategorized(profile.db, profile.id, token, preview.version);
    if (!rows.length) return preview;
    const connected = ai.status().connected;
    let suggestions: Awaited<ReturnType<typeof ai.suggestForRows>>['suggestions'] = new Map();
    let notice = connected ? undefined : 'Connect OpenAI in Settings for suggestions. You can choose categories here.';
    if (connected) {
      try { ({ suggestions, notice } = await ai.suggestForRows(rows, true)); }
      catch (error) {
        if (!(error instanceof UserError)) throw error;
        notice = error.message + ' You can choose categories here.';
      }
    }
    return imports.setReview(profile.db, profile.id, token, preview.version, rows, suggestions, notice);
  });
  handle('importModeration', empty, () => imports.moderation(active().id));
  handle('moderateImportCategory', moderateCategoryInput, (input) => imports.moderateCategory(db(), active().id, input));
  handle('resumeImport', empty, () => imports.resume(db(), active().id));
  handle('reviewImportRules', importRulesInput, (input) => imports.reviewRules(db(), active().id, input));
  handle('commitImport', commitInput, (input) => imports.commit(db(), active().id, input));
  handle('cancelImport', profileIdInput, ({ id }) => { imports.cancel(active().id, id); });
  handle('exportErrors', profileIdInput, ({ id }) => saveText('Export rejected rows', 'icash-import-errors.csv', () =>
    csv(['Source row', 'Reason', 'Original columns…'], imports.errors(active().id, id))));
  handle('batches', empty, () => batches(db()));
  handle('audit', profileIdInput, ({ id }) => auditRows(db(), id));
  handle('transactions', filters, (input) => listTransactions(db(), input));
  handle('transaction', profileIdInput, ({ id }) => transactionDetail(db(), id));
  handle('saveTransaction', transactionInput, (input) => saveTransaction(db(), input));
  handle('rules', empty, () => listRules(db()));
  handle('saveRule', saveRuleInput, (input) => saveRule(db(), input));
  handle('deleteRule', profileIdInput, ({ id }) => {
    db().prepare('DELETE FROM rules WHERE id=?').run(id);
    return listRules(db());
  });
  handle('saveMerchant', merchantInput, (input) => saveMerchant(db(), input));
  handle('previewRules', empty, () => recategorize(db(), false));
  handle('applyRules', z.object({ preview: rulePreview }), ({ preview }) => db().transaction(() => {
    if (JSON.stringify(recategorize(db(), false)) !== JSON.stringify(preview)) throw new UserError('The preview changed. Review the rules again.');
    return recategorize(db(), true);
  })());
  handle('budget', monthInput, ({ month }) => getBudget(db(), month));
  handle('saveAllocation', allocationInput, (input) => saveAllocation(db(), input));
  handle('saveDefault', defaultInput, (input) => saveDefault(db(), input));
  handle('copyBudget', copyInput, (input) => copyBudget(db(), input));
  handle('closeBudget', closeInput, (input) => setClosed(db(), input));
  handle('recommendations', monthInput, ({ month }) => recommend(db(), month));
  handle('transferCandidates', candidateInput, ({ id, days }) => transferCandidates(db(), id, days));
  handle('pairTransfer', pairInput, ({ first, second, days }) => pairTransfer(db(), first, second, days));
  handle('unlinkTransfer', profileIdInput, ({ id }) => { unlinkTransfer(db(), id); });
  handle('goals', empty, () => goals(db()));
  handle('saveGoal', goalInput, (input) => saveGoal(db(), input));
  handle('saveGoalEntry', entryInput, (input) => saveEntry(db(), input));
  handle('removeGoalEntry', profileIdInput, ({ id }) => removeEntry(db(), id));
  handle('goalTransfers', empty, () => goalTransfers(db()));
  handle('report', reportInput, (input) => report(db(), input));
  handle('exportReport', reportInput, (input) => saveText('Export financial report', 'icash-report.csv', () => {
    const row = report(db(), input);
    return numericCsv(['Period start', 'Period end', 'Metric', 'Category', 'ZAR'], [
      ...([
        ['Income', row.income], ['Net spending', row.expense], ['Operating cash flow', row.net],
        ['Household budget', row.allocated], ['Household budget actual', row.budgetActual],
        ['Household budget remaining', row.remaining], ['Savings to date', row.goalProgress],
      ] as const).map(([label, value]) => [row.start, row.end, label, '', value]),
      ...row.categories.map((entry) => [row.start, row.end, 'Net category spending', entry.name, entry.amount]),
    ]);
  }));
  handle('exportTransactions', exportTransactionsInput, ({ scope, ids }) => saveText('Export ledger', 'icash-transactions.csv', () => {
    const byId = new Map(listTransactions(db(), scope).map((row) => [row.id, row]));
    return numericCsv(['Date', 'Account', 'Description', 'Merchant', 'Bank amount (ZAR)', 'Contribution (ZAR)', 'Category', 'Treatment', 'Notes', 'Tags'],
      ids.flatMap((id) => {
        const row = byId.get(id);
        return row ? [[row.date, row.account, row.description, row.merchant, row.amount, row.contribution, row.category, row.treatment, row.notes, row.tags]] : [];
      }));
  }));
  handle('exportBackup', passphrase, async ({ passphrase }) => {
    const profile = active().id;
    const destination = await savePath('Save encrypted backup', 'household.icash-backup');
    if (!destination) return false;
    if (active().id !== profile) throw new UserError('The active profile changed.');
    exportBackup(profiles, destination, passphrase);
    return true;
  });
  handle('restoreBackup', passphrase, async ({ passphrase }) => {
    const source = await pick('Restore encrypted backup', ['icash-backup']);
    return source ? changeProfile(() => restoreBackup(profiles, source, passphrase)) : null;
  });
}
