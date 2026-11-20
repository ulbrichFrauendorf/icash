import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IAccordion, IButton, ICheckbox, IDialog, IMessage, IInputText, ISelect, ITextarea, ITable, ITag, PageHeaderActionsDirective, PageLayoutComponent, type GridData, type TableColumn, type TableDownloadEvent } from 'invensys-ng';
import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Ui, money, moneyText } from '../../shared/ui/state';
import { ZarPipe } from '../../shared/ui/pipes';
import { currencyColumn, sortableColumns, tableMoney } from '../../shared/ui/table-columns';
import type { AiClassification } from '../openai/contract';
import type { Category } from '../categories/contract';
import type { TransferCandidate } from '../transfers/contract';
import { filters, type EditTransaction, type Filters, type Transaction, type TransactionDetail } from './contract';

@Component({
  selector: 'icash-transactions',
  imports: [FormsModule, ZarPipe, IButton, IInputText, ISelect, ICheckbox, ITextarea, IAccordion, ITable, ITag, IDialog, IMessage, PageLayoutComponent, PageHeaderActionsDirective],
  templateUrl: './transactions.component.html',
})
export class TransactionsPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly data = signal<Transaction[]>([]);
  readonly loading = signal(true);
  readonly categories = signal<Category[]>([]);
  readonly draft = signal<TransactionDetail | null>(null);
  readonly aiDraft = signal<{ proposal: AiClassification; row: Transaction } | null>(null);
  readonly matches = signal<TransferCandidate[] | null>(null);
  readonly matchGrid = computed((): GridData<TransferCandidate> => {
    const transaction = this.draft();
    return {
      columns: sortableColumns([
        { field: 'date', header: 'Posting date' }, { field: 'account', header: 'Account' },
        { field: 'description', header: 'Description' }, currencyColumn('value', 'Amount'),
      ]),
      rows: (this.matches() ?? []).map((row) => ({ ...row, value: tableMoney(row.amount) })),
      actions: transaction ? [{ id: 'pair', icon: 'pi pi-link', label: 'Confirm pair',
        disabled: () => this.ui.busy(), handler: (row) => this.pair(transaction.id, row.id) }] : [],
    };
  });
  readonly scope = signal<Filters>({});
  private readonly table = viewChild(ITable);
  private request = 0;
  days = 3;
  splits: { categoryId: string; amount: string }[] = [];

  constructor() {
    inject(ActivatedRoute).queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const category = params.get('categoryId');
      const parsed = filters.safeParse({
        start: params.get('start') ?? undefined, end: params.get('end') ?? undefined,
        accountId: params.get('accountId') ?? undefined,
        categoryId: category === 'uncategorized' ? null : category ?? undefined,
        scoped: params.get('scoped') ?? undefined, type: params.get('type') ?? undefined,
      });
      this.scope.set(parsed.success ? parsed.data : {});
      this.draft.set(null);
      this.aiDraft.set(null);
      this.data.set([]);
      void this.ui.load(() => this.reload());
    });
    void this.ui.load(async () => {
      this.categories.set(await this.ui.api.categories());
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
      { field: 'date', header: 'Posting date', width: '8rem' }, { field: 'details', header: 'Description', width: '16rem' },
      { field: 'account', header: 'Account', width: '10rem' }, { field: 'classificationText', header: 'Category', width: '13rem' },
      { ...currencyColumn('bankAmount', 'Bank amount'), width: '9rem' }, { field: 'treatment', header: 'Treatment', width: '8rem' },
      { field: 'annotations', header: 'Notes and tags', width: '12rem' },
    ];
    if (this.scope().scoped) columns.splice(5, 0, { ...currencyColumn('contributionValue', 'Contribution'), width: '9rem' });
    return {
      columns: sortableColumns(columns),
      rows: this.data().map((row) => ({
        ...row,
        details: row.merchant ? row.description + ' · ' + row.merchant : row.description,
        classificationText: (row.hasSplits ? 'Split' : row.category || (row.treatment === 'transfer' ? 'Transfer' : 'Uncategorized')) +
          (row.excludeBudget || row.excludeReports
            ? ' · Excluded from ' + [row.excludeBudget ? 'budget' : '', row.excludeReports ? 'reports' : ''].filter(Boolean).join(' and ')
            : ''),
        bankAmount: tableMoney(row.amount), contributionValue: tableMoney(row.contribution),
        annotations: [row.notes, row.tags].filter(Boolean).join(' · '),
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

  private async reload() {
    const request = ++this.request;
    this.loading.set(true);
    try {
      const rows = await this.ui.api.transactions(this.scope());
      if (request === this.request) this.data.set(rows);
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }
  export(event: TableDownloadEvent) {
    const ids = (event.data as Transaction[]).map((row) => row.id);
    const scope = this.scope();
    return this.ui.run(async () => {
      if (await this.ui.api.exportTransactions({ scope, ids })) this.ui.info.set('Ledger exported.');
    });
  }
  exportResults() { this.table()?.handleDownload(); }
  private show(row: TransactionDetail) {
    this.draft.set(row);
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
      await this.ui.api.saveTransaction({ ...row,
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
