import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui, money, moneyText } from '../../shared/ui/state';
import { ZarPipe } from '../../shared/ui/pipes';
import type { Account } from '../accounts/contract';
import type { Category } from '../categories/contract';
import type { TransferCandidate } from '../transfers/contract';
import type { EditTransaction, Filters, TransactionDetail, TransactionPage } from './contract';

@Component({
  selector: 'icash-transactions',
  imports: [FormsModule, ZarPipe],
  template: `
    <div class="page-heading"><div><h1>Transactions</h1><p>Search the ledger and review how each transaction contributes.</p></div>
      <button [disabled]="ui.busy()" (click)="export()">Export results</button></div>
    <form class="panel stack" (ngSubmit)="search()">
      <div class="field-grid">
        <label>Search transactions <input name="search" [(ngModel)]="filter.text" placeholder="Description, merchant, note or tag"></label>
        <label>Account <select name="account" [(ngModel)]="filter.accountId"><option [ngValue]="undefined">All accounts</option>
          @for (a of accounts(); track a.id) { <option [value]="a.id">{{ a.name }}</option> }</select></label>
        <label>Category <select name="category" [(ngModel)]="filter.categoryId"><option [ngValue]="undefined">All categories</option><option [ngValue]="null">Uncategorized</option>
          @for (item of categories(); track item.id) { <option [value]="item.id">{{ label(item) }}</option> }</select></label>
        <label>Treatment <select name="type" [(ngModel)]="filter.type"><option [ngValue]="undefined">All</option>
          <option value="expense">Expense</option><option value="income">Income</option><option value="transfer">Transfer</option></select></label>
        <label>From <input name="from" type="date" [(ngModel)]="filter.start"></label>
        <label>To <input name="to" type="date" [(ngModel)]="filter.end"></label>
        <label>Merchant <input name="merchant" [(ngModel)]="filter.merchant"></label>
        <label>Minimum signed amount (R) <input name="minimum" [(ngModel)]="min" inputmode="decimal"></label>
        <label>Maximum signed amount (R) <input name="maximum" [(ngModel)]="max" inputmode="decimal"></label>
        <label>Sort <select name="sort" [(ngModel)]="filter.sort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="amount">Amount ascending</option></select></label>
      </div>
      <div class="actions"><button type="submit" class="primary" [disabled]="ui.busy()">Apply filters</button>
        <button type="button" [disabled]="ui.busy()" (click)="clear()">Clear filters</button>
        @if (filter.scoped) { <span class="badge">{{ filter.scoped }} contributors</span> }
      </div>
    </form>
    <section class="panel stack">
      <h2>Ledger <span class="muted">· {{ data().total }} results</span></h2>
      @if (!data().total) { <p class="empty">No transactions match. Import a statement or change your filters.</p> }
      @else {
        <div class="table-scroll"><table><thead><tr><th>Posting date</th><th>Description</th><th>Account</th><th>Category</th><th class="number">Bank amount</th>@if (applied.scoped) { <th class="number">Contribution</th> }<th></th></tr></thead><tbody>
          @for (row of data().rows; track row.id) {
            <tr><td class="nowrap">{{ row.date }}</td><td>{{ row.description }}@if (row.merchant) { <div class="muted">{{ row.merchant }}</div> }</td><td>{{ row.account }}</td>
              <td>{{ row.hasSplits ? 'Split' : row.category || (row.treatment === 'transfer' ? 'Transfer' : 'Uncategorized') }}
                @if (row.excludeBudget || row.excludeReports) { <div class="muted">Excluded from {{ row.excludeBudget ? 'budget' : '' }}{{ row.excludeBudget && row.excludeReports ? ' and ' : '' }}{{ row.excludeReports ? 'reports' : '' }}</div> }
              </td><td class="number">{{ row.amount | zar }}</td>
              @if (applied.scoped) { <td class="number">{{ row.contribution | zar }}</td> }
              <td><button [disabled]="ui.busy()" [attr.aria-label]="'Review ' + row.description" (click)="review(row.id)">Review</button></td></tr>
          }
        </tbody></table></div>
        <div class="actions">
          <button [disabled]="page === 0 || ui.busy()" (click)="turn(page - 1)">Previous page</button>
          <span>Page {{ page + 1 }}</span>
          <button [disabled]="(page + 1) * data().size >= data().total || ui.busy()" (click)="turn(page + 1)">Next page</button>
        </div>
      }
    </section>
    @if (draft(); as row) {
      <section class="panel stack" id="transaction-review">
        <div class="section-header"><div><h2>{{ row.description }}</h2><p>{{ row.date }} · {{ row.account }} · {{ row.amount | zar }}</p></div>
          <button (click)="draft.set(null)">Close review</button></div>
        <p class="muted">Classification · {{ row.rule || row.classification }} · Bank reference {{ row.reference || '—' }}</p>
        <div class="field-grid">
          <label>Treatment <select aria-label="Treatment" [ngModel]="row.treatment" (ngModelChange)="changeTreatment(row, $event)" [disabled]="!!row.pairId">
            <option value="expense">Expense / refund</option><option value="income">Income / reversal</option><option value="transfer">Internal transfer</option>
          </select></label>
          <label>Transaction category <select [(ngModel)]="row.categoryId" [disabled]="!!row.pairId || !!splits.length"><option [ngValue]="null">Uncategorized</option>
            @for (item of eligible(row); track item.id) { <option [ngValue]="item.id">{{ label(item) }}</option> }</select></label>
          <label>Merchant name <input [(ngModel)]="row.merchant" maxlength="120"></label>
          <label>Tags <input [(ngModel)]="row.tags" maxlength="300" placeholder="Comma-separated"></label>
        </div>
        <label>Notes <textarea [(ngModel)]="row.notes" maxlength="4000"></textarea></label>
        <div class="actions">
          <label class="check"><input type="checkbox" [(ngModel)]="row.excludeBudget"> Exclude from budgets</label>
          <label class="check"><input type="checkbox" [(ngModel)]="row.excludeReports"> Exclude from reports</label>
          @if (row.classification !== 'manual') {
            <label class="check"><input type="checkbox" [(ngModel)]="confirmClassification"> Keep this classification during rule updates</label>
          }
        </div>
        @if (row.treatment !== 'transfer') {
          <div class="stack"><h3>Split amount</h3>
            @for (line of splits; track $index) {
              <div class="field-grid">
                <label>Split category <select [(ngModel)]="line.categoryId"><option value="">Select category</option>
                  @for (item of eligible(row); track item.id) { <option [value]="item.id">{{ label(item) }}</option> }
                </select></label>
                <label>Signed split amount (R) <input [(ngModel)]="line.amount" inputmode="decimal"></label>
                <button (click)="splits.splice($index, 1)">Remove split</button>
              </div>
            }
            <button [disabled]="splits.length >= 30" (click)="splits.push({ categoryId: '', amount: '' })">Add split line</button>
          </div>
        }
        <div class="actions">
          <button class="primary" [disabled]="ui.busy()" (click)="save(row)">Save transaction</button>
          <button [disabled]="!row.categoryId || ui.busy()" (click)="futureRule(row)">Create rule for future matches</button>
          <button [disabled]="!row.categoryId || !row.merchant || ui.busy()" (click)="merchant(row)">Remember merchant</button>
        </div>
        <details>
          <summary>Transfer matching</summary>
          @if (row.pairId) {
            <p>Both linked legs are excluded from household income and expenses.</p>
            <button [disabled]="ui.busy()" (click)="unlink(row)">Unlink transfer</button>
          } @else {
            <p>Review possible matches from your other accounts before pairing them.</p>
            <div class="actions"><label>Date window (days) <input type="number" min="0" max="14" [(ngModel)]="days"></label>
              <button [disabled]="ui.busy()" (click)="findMatches(row.id)">Find transfer matches</button></div>
            @if (matches() !== null && !matches()?.length) { <p>No equal-and-opposite movements found.</p> }
            @for (item of matches(); track item.id) {
              <div class="list-row"><span>{{ item.date }} · {{ item.account }} · {{ item.description }} · {{ item.amount | zar }}</span>
                <button [disabled]="ui.busy()" (click)="pair(row.id, item.id)">Confirm pair</button></div>
            }
          }
        </details>
        <details><summary>Original statement row</summary><p>Row {{ row.sourceRow }} · {{ row.original.join(' · ') }}</p>
          <p>Statement balance {{ row.balance | zar }}</p></details>
      </section>
    }
  `,
})
export class TransactionsPage {
  readonly ui = inject(Ui);
  readonly data = signal<TransactionPage>({ rows: [], total: 0, size: 50 });
  readonly accounts = signal<Account[]>([]);
  readonly categories = signal<Category[]>([]);
  readonly draft = signal<TransactionDetail | null>(null);
  readonly matches = signal<TransferCandidate[] | null>(null);
  filter: Filters = { sort: 'newest', ...this.ui.transactionFilter() };
  applied: Filters = { ...this.filter };
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
  label(item: Category) {
    const parent = this.categories().find((category) => category.id === item.parentId);
    return parent ? parent.name + ' / ' + item.name : item.name;
  }
  eligible(row: TransactionDetail) {
    return this.categories().filter((item) => item.leaf &&
      (!item.archived || item.id === row.categoryId || row.splits.some((line) => line.categoryId === item.id)) &&
      (item.kind === row.treatment || item.kind === 'savings' && row.treatment === 'transfer'));
  }
  private async reload(page = this.page) {
    this.data.set(await this.ui.api.transactions({ ...this.applied, page }));
    this.page = page;
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
      requestAnimationFrame(() => document.getElementById('transaction-review')?.scrollIntoView({ block: 'start' }));
    });
  }
  changeTreatment(row: TransactionDetail, value: EditTransaction['treatment']) { row.treatment = value; row.categoryId = null; this.splits = []; }
  save(row: TransactionDetail) {
    return this.ui.run(async () => {
      this.show(await this.ui.api.saveTransaction({ ...row, confirmClassification: this.confirmClassification, splits: this.splits.map((line) => ({ ...line, amount: money(line.amount) })) }));
      await this.reload();
    }, 'Transaction saved.');
  }
  futureRule(row: TransactionDetail) {
    const categoryId = row.categoryId;
    if (!categoryId) return;
    const long = row.description.length > 200;
    if (!window.confirm(long ? 'Create a rule for the first 200 characters and this direction?' :
      'Create a rule for future transactions with this exact description and direction?')) return;
    return this.ui.run(() => this.ui.api.saveRule({ name: row.description.slice(0, 80), categoryId, priority: 50, enabled: true,
      conditions: { field: 'description', operator: long ? 'startsWith' : 'equals', text: row.description.slice(0, 200), direction: row.amount < 0 ? 'debit' : 'credit' } }), 'Future rule created.');
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
    if (!row.pairId || !window.confirm('Unlink these movements and restore their original classifications?')) return;
    const id = row.pairId;
    return this.ui.run(async () => {
      await this.ui.api.unlinkTransfer({ id });
      this.show(await this.ui.api.transaction({ id: row.id }));
      await this.reload();
    }, 'Transfer unlinked.');
  }
}
