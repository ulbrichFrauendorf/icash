import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IButton, ICalendar, ICard, IInputText, ISelect, ITable, PageHeaderActionsDirective, PageHeaderContentDirective, PageLayoutComponent, PageRightSidebarDirective, type GridData } from 'invensys-ng';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Requests } from '../../shared/api';
import { localDate } from '../../shared/finance';
import { money, moneyText, Ui } from '../../shared/ui/state';
import { revealPageSidebar } from '../../shared/ui/navigation';
import { currencyColumn, sortableColumns, tableMoney } from '../../shared/ui/table-columns';
import type { Goal, GoalEntry } from './contract';

@Component({
  selector: 'icash-savings',
  imports: [FormsModule, IButton, ICalendar, IInputText, ISelect, ICard, ITable, PageLayoutComponent, PageHeaderActionsDirective, PageHeaderContentDirective, PageRightSidebarDirective],
  templateUrl: './savings.component.html',
})
export class SavingsPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly goals = signal<Goal[]>([]);
  readonly transfers = signal<Requests['goalTransfers'][1]>([]);
  readonly grid = computed((): GridData<Goal, GoalEntry> => ({
    columns: sortableColumns([
      { field: 'name', header: 'Goal' }, currencyColumn('progressValue', 'Saved'), currencyColumn('targetValue', 'Target'),
      { field: 'percent', header: 'Progress (%)', align: 'right', type: 'number' }, { field: 'due', header: 'Due date' },
    ]),
    rows: this.goals().map((row) => ({ ...row, progressValue: tableMoney(row.progress), targetValue: tableMoney(row.target),
      percent: Math.round(row.progress / row.target * 100) })),
    actions: [
      { id: 'edit', icon: 'pi pi-pencil', tooltip: (row) => 'Edit ' + row.name, handler: (row) => this.edit(row) },
      { id: 'contribute', icon: 'pi pi-plus', tooltip: (row) => 'Record movement for ' + row.name, handler: (row) => {
        this.goalId = row.id; this.showEditor('savings-movement');
      } },
    ],
    details: {
      columns: sortableColumns([{ field: 'date', header: 'Date' }, currencyColumn('value', 'Amount'), { field: 'source', header: 'Source' }]),
      rows: (row) => row.entries.map((entry) => ({ ...entry, value: tableMoney(entry.amount), source: entry.pairId ? 'Paired transfer' : 'Manual' })),
      actions: [{ id: 'remove', icon: 'pi pi-trash', tooltip: 'Remove movement', disabled: () => this.ui.busy(), handler: (row) => this.remove(row.id) }],
    },
  }));
  editorVisible = true;
  draft: { id?: string; name: string; target: string; due: Date | null } = { name: '', target: '', due: null };
  goalId = '';
  pairId = '';
  amount = '';
  date: Date | null = new Date();
  constructor() {
    void this.ui.load(async () => {
      const [goals, transfers] = await Promise.all([this.ui.api.goals(), this.ui.api.goalTransfers()]);
      this.goals.set(goals); this.transfers.set(transfers);
    });
  }
  edit(goal: Goal) {
    this.draft = { id: goal.id, name: goal.name, target: moneyText(goal.target),
      due: goal.due ? new Date(goal.due + 'T12:00:00') : null };
    this.showEditor();
  }
  reset() { this.draft = { name: '', target: '', due: null }; }
  add() { this.reset(); this.showEditor(); }
  private showEditor(id = 'savings-editor') { this.editorVisible = true; revealPageSidebar(id); }
  save() {
    return this.ui.run(async () => {
      this.goals.set(await this.ui.api.saveGoal({ ...this.draft, due: this.draft.due ? localDate(this.draft.due) : null, target: money(this.draft.target) }));
      this.reset();
    }, 'Savings goal saved.');
  }
  readonly transferLabel = (pair: Requests['goalTransfers'][1][number]) => pair.date + ' · ' + pair.label + ' · R ' + moneyText(pair.amount);
  chooseTransfer(id: string) {
    const pair = this.transfers().find((row) => row.id === id);
    if (pair) { this.amount = moneyText(pair.amount); this.date = new Date(pair.date + 'T12:00:00'); }
  }
  contribute() {
    if (!this.date) return;
    const date = localDate(this.date);
    return this.ui.run(async () => {
      this.goals.set(await this.ui.api.saveGoalEntry({ goalId: this.goalId, pairId: this.pairId || null, amount: money(this.amount), date }));
      this.transfers.set(await this.ui.api.goalTransfers());
      this.amount = ''; this.pairId = '';
    }, 'Savings movement recorded.');
  }
  remove(id: string) {
    return this.ui.confirm('Remove this movement from the savings goal?', () => {
      void this.ui.run(async () => {
        this.goals.set(await this.ui.api.removeGoalEntry({ id }));
        this.transfers.set(await this.ui.api.goalTransfers());
      }, 'Savings movement removed.');
    }, 'danger');
  }
}
