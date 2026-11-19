import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IAccordion, IButton, ICard, ICheckbox, IDialog, IMessage, IInputText, ISelect, ITextarea, ITable, ITag, type GridData, type TableColumn, NoContentComponent } from 'invensys-ng';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui, money, moneyText } from '../../shared/ui/state';
import { formatZar, ZarPipe } from '../../shared/ui/pipes';
import type { AiClassification } from '../openai/contract';
import type { Account } from '../accounts/contract';
import type { Category } from '../categories/contract';
import type { TransferCandidate } from '../transfers/contract';
import type { EditTransaction, Filters, Transaction, TransactionDetail, TransactionPage } from './contract';

@Component({
  selector: 'icash-transactions',
  imports: [FormsModule, ZarPipe, IButton, IInputText, ISelect, ICheckbox, ITextarea, ICard, IAccordion, ITable, ITag, IDialog, IMessage, NoContentComponent],
  templateUrl: './transactions.component.html',
})
export class TransactionsPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly data = signal<TransactionPage>({ rows: [], total: 0, size: 50 });
  readonly accounts = signal<Account[]>([]);
  readonly categories = signal<Category[]>([]);
  readonly draft = signal<TransactionDetail | null>(null);
  readonly aiDraft = signal<{ proposal: AiClassification; row: Transaction } | null>(null);
  readonly matches = signal<TransferCandidate[] | null>(null);
  filter: Filters = { sort: 'newest', ...this.ui.transactionFilter() };
  private applied: Filters = { ...this.filter };
  private readonly scope = signal(this.applied.scoped);
  page = 0;
  min = '';
  max = '';
  days = 3;
  confirmClassification = false;
  splits: { categoryId: string; amount: string }[] = [];

  constructor() {
    void this.ui.load(async () => {
      const [accounts, categories] = await Promise.all([this.ui.api.accounts(), this.ui.api.categories()]);
      this.accounts.set(accounts); this.categories.set(categories);
      await this.reload(0);
    });
  }
  readonly categoryLabel = (item: Category) => this.label(item);
  label(item: Category) {
    const parent = this.categories().find((category) => category.id === item.parentId);
    return parent ? parent.name + ' / ' + item.name : item.name;
  }
  eligible(row: TransactionDetail) {
    return this.categories().filter((item) => item.leaf &&
      (!item.archived || item.id === row.categoryId || row.splits.some((line) => line.categoryId === item.id)) &&
      (item.kind === row.treatment || item.kind === 'savings' && row.treatment === 'transfer'));
  }

  readonly ledger = computed((): GridData => {
    const columns: TableColumn[] = [
      { field: 'date', header: 'Posting date' }, { field: 'details', header: 'Description' },
      { field: 'account', header: 'Account' }, { field: 'classificationText', header: 'Category' },
      { field: 'bankAmount', header: 'Bank amount', align: 'right' },
    ];
    if (this.scope()) columns.push({ field: 'contributionText', header: 'Contribution', align: 'right' });
    return {
      columns,
      rows: this.data().rows.map((row) => ({
        ...row,
        details: row.merchant ? row.description + ' · ' + row.merchant : row.description,
        classificationText: (row.hasSplits ? 'Split' : row.category || (row.treatment === 'transfer' ? 'Transfer' : 'Uncategorized')) +
          (row.excludeBudget || row.excludeReports
            ? ' · Excluded from ' + [row.excludeBudget ? 'budget' : '', row.excludeReports ? 'reports' : ''].filter(Boolean).join(' and ')
            : ''),
        bankAmount: formatZar(row.amount), contributionText: formatZar(row.contribution),
      })),
      actions: [{
        id: 'review', icon: 'pi pi-pencil', tooltip: (row) => 'Review ' + row.description,
        disabled: () => this.ui.busy(), handler: (row) => this.review(row.id),
      }, {
        id: 'ai-classify', icon: 'pi pi-sparkles', tooltip: (row) => 'AI classify ' + row.description,
        visible: (row) => !row.hasSplits && row.treatment !== 'transfer' && !row.pairId,
        disabled: () => this.ui.busy(), handler: (row) => this.suggestCategory(row),
      }],
    };
  });

  private async reload(page = this.page) {
    this.data.set(await this.ui.api.transactions({ ...this.applied, page }));
    this.page = page;
    this.scope.set(this.applied.scoped);
  }
  search() {
    return this.ui.run(async () => {
      this.applied = { ...this.filter, start: this.filter.start || undefined, end: this.filter.end || undefined,
        minimum: this.min ? money(this.min) : undefined, maximum: this.max ? money(this.max) : undefined };
      await this.reload(0);
    });
  }
  clear() {
    this.filter = { sort: 'newest' }; this.min = ''; this.max = '';
    return this.search();
  }
  turn(page: number) { return this.ui.run(() => this.reload(page)); }
  export() { return this.ui.run(async () => { if (await this.ui.api.exportTransactions(this.applied)) this.ui.info.set('Ledger exported.'); }); }
  private show(row: TransactionDetail) {
    this.draft.set(row);
    this.confirmClassification = false;
    this.splits = row.splits.map((line) => ({ ...line, amount: moneyText(line.amount) }));
    this.matches.set(null);
  }
  review(id: string) {
    return this.ui.run(async () => {
      this.show(await this.ui.api.transaction({ id }));
    });
  }
  changeTreatment(row: TransactionDetail, value: EditTransaction['treatment']) { row.treatment = value; row.categoryId = null; this.splits = []; }
  save(row: TransactionDetail) {
    return this.ui.run(async () => {
      await this.ui.api.saveTransaction({ ...row, confirmClassification: this.confirmClassification,
        splits: this.splits.map((line) => ({ ...line, amount: money(line.amount) })) });
      this.draft.set(null);
      await this.reload();
    }, 'Transaction saved.');
  }
  suggestCategory(row: Transaction) {
    return this.ui.run(async () => {
      const proposal = await this.ui.api.suggestAiCategory({ id: row.id });
      this.aiDraft.set({ row, proposal });
    });
  }
  applyCategory(proposal: AiClassification) {
    return this.ui.run(async () => {
      await this.ui.api.applyAiCategory({ id: proposal.token });
      this.aiDraft.set(null);
      this.categories.set(await this.ui.api.categories());
      await this.reload();
    }, proposal.ruleId ? 'Existing rule applied.' : 'AI category saved.');
  }
  futureRule(row: TransactionDetail) {
    const categoryId = row.categoryId;
    if (!categoryId) return;
    const long = row.description.length > 200;
    return this.ui.confirm(long ? 'Create a rule for the first 200 characters and this direction?' :
      'Create a rule for future transactions with this exact description and direction?', () => {
      void this.ui.run(() => this.ui.api.saveRule({ name: row.description.slice(0, 80), categoryId, priority: 50, enabled: true,
        conditions: { field: 'description', operator: long ? 'startsWith' : 'equals', text: row.description.slice(0, 200), direction: row.amount < 0 ? 'debit' : 'credit' } }), 'Future rule created.');
    });
  }
  merchant(row: TransactionDetail) {
    const categoryId = row.categoryId;
    if (!categoryId) return;
    return this.ui.run(() => this.ui.api.saveMerchant({ merchant: row.merchant, categoryId, direction: row.amount < 0 ? 'debit' : 'credit' }), 'Merchant mapping saved.');
  }
  findMatches(id: string) { return this.ui.run(async () => this.matches.set(await this.ui.api.transferCandidates({ id, days: this.days }))); }
  pair(first: string, second: string) {
    return this.ui.run(async () => { this.show(await this.ui.api.pairTransfer({ first, second, days: this.days })); await this.reload(); }, 'Transfer paired.');
  }
  unlink(row: TransactionDetail) {
    const id = row.pairId;
    if (!id) return;
    return this.ui.confirm('Unlink these movements and restore their original classifications?', () => {
      void this.ui.run(async () => {
        await this.ui.api.unlinkTransfer({ id });
        this.show(await this.ui.api.transaction({ id: row.id }));
        await this.reload();
      }, 'Transfer unlinked.');
    });
  }
}
