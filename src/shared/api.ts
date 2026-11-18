import type { z } from 'zod';
import type { Account, coverageInput, saveAccountInput } from '../features/accounts/contract';
import type { Category, mergeInput, saveCategoryInput } from '../features/categories/contract';
import type { TemplatePreview } from '../features/categories/portable';
import type { merchantInput, Rule, RulePreview, saveRuleInput } from '../features/categorization/contract';
import type { AuditRow, Batch, commitInput, decodeInput, FilePreview, ImportPreview, ImportResult, previewInput } from '../features/import-statement/contract';
import type { allocationInput, Budget, closeInput, copyInput, defaultInput, Recommendations } from '../features/monthly-budget/contract';
import type { createProfileInput, ProfileState, selectThemeInput } from '../features/profiles/contract';
import type { Schedule, scheduleInput } from '../features/recurring/contract';
import type { Report, reportInput } from '../features/reports/contract';
import type { entryInput, Goal, goalInput } from '../features/savings-goals/contract';
import type { EditTransaction, Filters, TransactionDetail, TransactionPage } from '../features/transactions/contract';
import type { candidateInput, pairInput, TransferCandidate } from '../features/transfers/contract';

type Data<T extends z.ZodType> = z.input<T>;
type ID = { id: string };
type Month = { month: string };

export interface Requests {
  getProfiles: [undefined, ProfileState];
  createProfile: [Data<typeof createProfileInput>, ProfileState];
  selectProfile: [ID, ProfileState];
  deleteProfile: [ID, ProfileState];
  setTheme: [Data<typeof selectThemeInput>, ProfileState];
  accounts: [undefined, Account[]];
  saveAccount: [Data<typeof saveAccountInput>, Account[]];
  confirmCoverage: [Data<typeof coverageInput>, void];
  categories: [undefined, Category[]];
  saveCategory: [Data<typeof saveCategoryInput>, Category[]];
  categoryUsage: [ID, Record<string, number>];
  mergeCategories: [Data<typeof mergeInput>, Category[]];
  restoreDefaults: [undefined, Category[]];
  exportTemplate: [undefined, boolean];
  previewTemplate: [undefined, TemplatePreview | null];
  commitTemplate: [ID, TemplatePreview];
  selectImport: [ID, FilePreview | null];
  decodeImport: [Data<typeof decodeInput>, FilePreview];
  previewImport: [Data<typeof previewInput>, ImportPreview];
  commitImport: [Data<typeof commitInput>, ImportResult];
  cancelImport: [ID, void];
  exportErrors: [ID, boolean];
  batches: [undefined, Batch[]];
  audit: [{ id: string; page: number }, AuditRow[]];
  transactions: [Filters, TransactionPage];
  transaction: [ID, TransactionDetail];
  saveTransaction: [EditTransaction, TransactionDetail];
  rules: [undefined, Rule[]];
  saveRule: [Data<typeof saveRuleInput>, Rule[]];
  deleteRule: [ID, Rule[]];
  saveMerchant: [Data<typeof merchantInput>, void];
  previewRules: [undefined, RulePreview];
  applyRules: [{ preview: RulePreview }, RulePreview];
  budget: [Month, Budget];
  saveAllocation: [Data<typeof allocationInput>, Budget];
  saveDefault: [Data<typeof defaultInput>, Budget];
  copyBudget: [Data<typeof copyInput>, Budget];
  closeBudget: [Data<typeof closeInput>, Budget];
  recommendations: [Month, Recommendations];
  transferCandidates: [Data<typeof candidateInput>, TransferCandidate[]];
  pairTransfer: [Data<typeof pairInput>, TransactionDetail];
  unlinkTransfer: [ID, void];
  goals: [undefined, Goal[]];
  saveGoal: [Data<typeof goalInput>, Goal[]];
  saveGoalEntry: [Data<typeof entryInput>, Goal[]];
  removeGoalEntry: [ID, Goal[]];
  goalTransfers: [undefined, { id: string; date: string; amount: number; label: string }[]];
  schedules: [undefined, Schedule[]];
  saveSchedule: [Data<typeof scheduleInput>, Schedule[]];
  report: [Data<typeof reportInput>, Report];
  exportReport: [Data<typeof reportInput>, boolean];
  exportTransactions: [Filters, boolean];
  exportBackup: [{ passphrase: string }, boolean];
  restoreBackup: [{ passphrase: string }, ProfileState | null];
}

export type Api = {
  [K in keyof Requests]: Requests[K][0] extends undefined ? () => Promise<Requests[K][1]> :
    (input: Requests[K][0]) => Promise<Requests[K][1]>;
};

export const channels: { [K in keyof Requests]: K } = {
  getProfiles: 'getProfiles', createProfile: 'createProfile', selectProfile: 'selectProfile', deleteProfile: 'deleteProfile',
  setTheme: 'setTheme', accounts: 'accounts', saveAccount: 'saveAccount', confirmCoverage: 'confirmCoverage',
  categories: 'categories', saveCategory: 'saveCategory', categoryUsage: 'categoryUsage',
  mergeCategories: 'mergeCategories', restoreDefaults: 'restoreDefaults', exportTemplate: 'exportTemplate',
  previewTemplate: 'previewTemplate', commitTemplate: 'commitTemplate', selectImport: 'selectImport',
  decodeImport: 'decodeImport', previewImport: 'previewImport', commitImport: 'commitImport', cancelImport: 'cancelImport', exportErrors: 'exportErrors',
  batches: 'batches', audit: 'audit', transactions: 'transactions', transaction: 'transaction',
  saveTransaction: 'saveTransaction', rules: 'rules', saveRule: 'saveRule', deleteRule: 'deleteRule',
  saveMerchant: 'saveMerchant', previewRules: 'previewRules', applyRules: 'applyRules',
  budget: 'budget', saveAllocation: 'saveAllocation', saveDefault: 'saveDefault', copyBudget: 'copyBudget',
  closeBudget: 'closeBudget', recommendations: 'recommendations', transferCandidates: 'transferCandidates',
  pairTransfer: 'pairTransfer', unlinkTransfer: 'unlinkTransfer', goals: 'goals', saveGoal: 'saveGoal',
  saveGoalEntry: 'saveGoalEntry', removeGoalEntry: 'removeGoalEntry', goalTransfers: 'goalTransfers',
  schedules: 'schedules', saveSchedule: 'saveSchedule', report: 'report', exportReport: 'exportReport',
  exportTransactions: 'exportTransactions', exportBackup: 'exportBackup', restoreBackup: 'restoreBackup',
};

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };
