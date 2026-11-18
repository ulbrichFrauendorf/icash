import { retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, ICheckbox, IInputText, IMessage, ISelect, ITable, ITag, type GridData, type GridAction, type TableColumn, NoContentComponent } from 'invensys-ng';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { monthEnd, shiftMonth } from '../../shared/finance';
import { Ui, money, moneyText } from '../../shared/ui/state';
import { formatZar, ZarPipe } from '../../shared/ui/pipes';
import type { Budget, BudgetRow, Recommendations } from './contract';

@Component({
  selector: 'icash-budgets',
  imports: [FormsModule, ZarPipe, IButton, IInputText, ISelect, ICheckbox, ICard, IMessage, ITable, ITag, NoContentComponent],
  templateUrl: './budgets.component.html',
})
export class BudgetsPage {
  readonly selectedChoice = retainChoice();
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
  readonly allocations = computed((): GridData<BudgetRow, BudgetRow> => {
    const budget = this.budget();
    const rows = budget?.rows ?? [];
    const columns: TableColumn[] = [
      { field: 'label', header: 'Category' }, { field: 'allocationValue', header: 'Allocated', align: 'right' },
      { field: 'carryValue', header: 'Rollover', align: 'right' }, { field: 'actualValue', header: 'Actual', align: 'right' },
      { field: 'remainingValue', header: 'Remaining', align: 'right', severity: (row: BudgetRow) => (row.remaining ?? 0) < 0 ? 'danger' : '' },
      { field: 'usageValue', header: 'Usage', align: 'right' },
    ];
    const present = (row: BudgetRow) => ({
      ...row,
      label: row.name + (row.archived ? ' · archived' : ''),
      allocationValue: formatZar(row.allocated), carryValue: formatZar(row.rollover), actualValue: formatZar(row.actual),
      remainingValue: formatZar(row.remaining), usageValue: row.usage === null ? '—' : row.usage.toFixed(0) + '%',
    });
    const actions: GridAction<BudgetRow>[] = budget?.closed ? [] : [
      { id: 'contributors', icon: 'pi pi-list', tooltip: (row) => 'Review spending for ' + row.name, handler: (row) => this.drill(row.categoryId) },
      { id: 'edit', icon: 'pi pi-pencil', tooltip: (row) => 'Edit allocation for ' + row.name, handler: (row) => this.edit(row),
        visible: (row) => !!row.categoryId && row.leaf && !row.archived },
    ];
    return {
      columns, rows: rows.filter((row) => !row.parent).map(present), actions,
      details: { columns, actions, rows: (parent) => parent.leaf ? [] : rows.filter((row) => row.parent === parent.categoryId).map(present) },
    };
  });
  readonly suggestionGrid = computed((): GridData => ({
    columns: [
      { field: 'name', header: 'Category' }, { field: 'suggestion', header: 'Suggested', align: 'right' },
      { field: 'mean', header: 'Average', align: 'right' }, { field: 'range', header: 'Range' },
      { field: 'trendLabel', header: 'Trend', align: 'right' },
    ],
    rows: (this.recommendations()?.rows ?? []).map((row) => ({ ...row, suggestion: formatZar(row.amount),
      mean: formatZar(row.average), range: formatZar(row.minimum) + ' to ' + formatZar(row.maximum), trendLabel: formatZar(row.trend) })),
    actions: [{ id: 'accept', icon: 'pi pi-check', label: 'Use suggestion',
      disabled: () => !!this.budget()?.closed || this.ui.busy(), handler: (row) => this.use(row.categoryId, row.amount) }],
  }));
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
    return this.ui.confirm('Copy the previous month’s configured allocations into categories without a saved override?', () => {
      void this.ui.run(async () => this.budget.set(await this.ui.api.copyBudget({ month: this.month, from: shiftMonth(this.month, -1) })), 'Budget copied.');
    });
  }
  close(data: Budget) {
    return this.ui.confirm(data.closed ? 'Reopen this month for editing?' : 'Save the current budget and actuals as a closed revision?', () => {
      void this.ui.run(async () => { this.budget.set(await this.ui.api.closeBudget({ month: this.month, closed: !data.closed })); this.selected = null; });
    });
  }
  suggest() { return this.ui.run(async () => this.recommendations.set(await this.ui.api.recommendations({ month: this.month }))); }
  use(id: string, amount: number | null) {
    const row = this.budget()?.rows.find((entry) => entry.categoryId === id);
    if (!row || amount === null) return;
    this.edit(row); this.amount = moneyText(amount);
  }
}
