import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { monthEnd, shiftMonth } from '../../shared/finance';
import { Ui, money, moneyText } from '../../shared/ui/state';
import { ZarPipe } from '../../shared/ui/pipes';
import type { Budget, BudgetRow, Recommendations } from './contract';

@Component({
  selector: 'icash-budgets',
  imports: [FormsModule, ZarPipe],
  template: `
    <div class="page-heading"><div><h1>Monthly budgets</h1><p>Set spending limits and compare them with what you actually spent.</p></div>
      <label>Budget month <input type="month" [ngModel]="month" (ngModelChange)="pick($event)" [disabled]="ui.busy()"></label></div>
    @if (budget(); as data) {
      <div class="metric-grid">
        <section class="metric"><span>Allocated</span><strong>{{ data.allocated | zar }}</strong></section>
        <section class="metric"><span>Rollover</span><strong>{{ data.rollover | zar }}</strong></section>
        <section class="metric"><span>Actual spending</span><strong>{{ data.actual | zar }}</strong></section>
        <section class="metric accent"><span>Budget remaining</span><strong data-testid="budget-remaining">{{ data.remaining | zar }}</strong></section>
      </div>
      <section class="panel stack">
        <div class="section-header"><h2>Category allocations</h2><div class="actions">
          <button [disabled]="data.closed || ui.busy()" (click)="copy()">Copy previous month</button>
          <button [disabled]="ui.busy()" (click)="close(data)">{{ data.closed ? 'Reopen month' : 'Close month' }}</button>
        </div></div>
        @if (data.closed) { <p class="badge">Closed · revision {{ data.revision }}</p> }
        @if (data.changed) { <p class="warning">The current ledger differs from this revision. Net change in spending {{ data.delta | zar }}. Reopen the month to review.</p> }
        <div class="table-scroll"><table><thead><tr><th>Category</th><th class="number">Allocated</th><th class="number">Rollover</th><th class="number">Actual</th><th class="number">Remaining</th><th class="number">Usage</th><th></th></tr></thead><tbody>
        @for (row of ordered(data); track row.categoryId) {
          <tr [class.group-row]="!row.leaf"><td [class.child]="row.parent">{{ row.name }}{{ row.archived ? ' · archived' : '' }}</td>
            <td class="number">{{ row.allocated | zar }}</td><td class="number">{{ row.rollover | zar }}</td>
            <td class="number">
              @if (!data.closed) { <button class="text-button" (click)="drill(row.categoryId)">{{ row.actual | zar }}</button> }
              @else { {{ row.actual | zar }} }
            </td><td class="number" [class.negative]="(row.remaining ?? 0) < 0">{{ row.remaining | zar }}</td>
            <td class="number">{{ row.usage === null ? '—' : percent(row.usage) }}</td>
            <td>@if (row.leaf && row.categoryId && !row.archived && !data.closed) {
              <button [attr.aria-label]="'Edit allocation for ' + row.name" (click)="edit(row)">Edit</button>
            }</td></tr>
        }
        </tbody></table></div>
      </section>
      @if (selected; as current) {
        <section class="panel stack" id="allocation-editor">
          <h2>Allocation for {{ current.name }}</h2>
          <div class="field-grid">
            <label>Budget amount (R) <input [(ngModel)]="amount" inputmode="decimal" placeholder="Use a period for decimals"></label>
            <label>Apply to <select [(ngModel)]="cadence">
              <option value="once">This month</option><option value="monthly">From this month · monthly target</option>
              <option value="weekly">From this month · weekly target</option><option value="annual">From this month · annual target</option>
            </select></label>
            <label class="check"><input type="checkbox" [(ngModel)]="rollover"> Carry unused funds to next month</label>
          </div>
          <p class="muted">Leave the amount blank to remove the single-month override or stop a future target.</p>
          <div class="actions"><button class="primary" [disabled]="ui.busy()" (click)="save()">Save allocation</button><button (click)="selected = null">Cancel</button></div>
        </section>
      }
      <section class="panel stack">
        <h2>Suggested allocations</h2>
        <p>Recommendations use the median of up to six fully covered prior months. Confirm missing coverage in Accounts.</p>
        <button [disabled]="ui.busy()" (click)="suggest()">Review suggestions</button>
        @if (recommendations(); as result) {
          @if (!result.months.length) { <p class="empty">No complete prior months are available.</p> }
          @else {
            <p>{{ result.months.join(', ') }}{{ result.months.length < 3 ? ' · Limited history' : '' }}</p>
            <div class="table-scroll"><table class="compact"><thead><tr><th>Category</th><th>Suggested</th><th>Average</th><th>Range</th><th>Trend</th><th></th></tr></thead><tbody>
              @for (row of result.rows; track row.categoryId) {
                <tr><td>{{ row.name }}</td><td>{{ row.amount | zar }}</td><td>{{ row.average | zar }}</td>
                  <td>{{ row.minimum | zar }} to {{ row.maximum | zar }}</td><td>{{ row.trend | zar }}</td>
                  <td><button [disabled]="data.closed || ui.busy()" (click)="use(row.categoryId, row.amount)">Use suggestion</button></td></tr>
              }
            </tbody></table></div>
          }
        }
      </section>
    }
  `,
})
export class BudgetsPage {
  readonly ui = inject(Ui);
  readonly budget = signal<Budget | null>(null);
  readonly recommendations = signal<Recommendations | null>(null);
  month = this.ui.month();
  selected: BudgetRow | null = null;
  amount = '';
  cadence: 'once' | 'monthly' | 'weekly' | 'annual' = 'once';
  rollover = false;

  constructor() { void this.ui.load(async () => this.budget.set(await this.ui.api.budget({ month: this.month }))); }
  pick(month: string) {
    if (!month) return;
    return this.ui.run(async () => {
      this.budget.set(await this.ui.api.budget({ month }));
      this.month = month; this.ui.month.set(month); this.selected = null; this.recommendations.set(null);
    });
  }
  ordered(data: Budget) {
    return data.rows.filter((row) => !row.parent).flatMap((row) => row.leaf ? [row] :
      [row, ...data.rows.filter((child) => child.parent === row.categoryId)]);
  }
  percent(value: number) { return value.toFixed(0) + '%'; }
  drill(categoryId: string | null) { this.ui.go('Transactions', { categoryId, scoped: 'budget', start: this.month + '-01', end: monthEnd(this.month) }); }
  edit(row: BudgetRow) {
    this.selected = row; this.amount = row.allocated === null ? '' : moneyText(row.allocated);
    this.cadence = 'once'; this.rollover = row.carryForward;
    requestAnimationFrame(() => document.getElementById('allocation-editor')?.scrollIntoView({ block: 'center' }));
  }
  save() {
    const categoryId = this.selected?.categoryId;
    if (!categoryId) return;
    return this.ui.run(async () => {
      const input = { month: this.month, categoryId, amount: this.amount.trim() ? money(this.amount) : null, rollover: this.rollover };
      this.budget.set(this.cadence === 'once' ? await this.ui.api.saveAllocation(input) :
        await this.ui.api.saveDefault({ ...input, cadence: this.cadence }));
      this.selected = null;
    }, 'Budget allocation saved.');
  }
  copy() {
    if (!window.confirm('Copy the previous month’s configured allocations into categories without a saved override?')) return;
    return this.ui.run(async () => this.budget.set(await this.ui.api.copyBudget({ month: this.month, from: shiftMonth(this.month, -1) })), 'Budget copied.');
  }
  close(data: Budget) {
    if (!window.confirm(data.closed ? 'Reopen this month for editing?' : 'Save the current budget and actuals as a closed revision?')) return;
    return this.ui.run(async () => { this.budget.set(await this.ui.api.closeBudget({ month: this.month, closed: !data.closed })); this.selected = null; });
  }
  suggest() { return this.ui.run(async () => this.recommendations.set(await this.ui.api.recommendations({ month: this.month }))); }
  use(id: string, amount: number | null) {
    const row = this.budget()?.rows.find((entry) => entry.categoryId === id);
    if (!row || amount === null) return;
    this.edit(row); this.amount = moneyText(amount);
  }
}
