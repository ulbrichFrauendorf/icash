import { retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, IInputText, ISelect, ITable, PageHeaderActionsDirective, PageHeaderContentDirective, PageLayoutComponent, PageRightSidebarDirective, type GridData } from 'invensys-ng';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { currentDate, money, moneyText, Ui } from '../../shared/ui/state';
import { revealPageSidebar } from '../../shared/ui/navigation';
import { currencyColumn, sortableColumns, tableMoney } from '../../shared/ui/table-columns';
import type { Schedule } from './contract';

@Component({
  selector: 'icash-recurring',
  imports: [FormsModule, IButton, IInputText, ISelect, ICard, ITable, PageLayoutComponent, PageHeaderActionsDirective, PageHeaderContentDirective, PageRightSidebarDirective],
  templateUrl: './recurring.component.html',
})
export class RecurringPage {
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly list = signal<Schedule[]>([]);
  readonly grid = computed((): GridData<Schedule> => ({
    columns: sortableColumns([
      { field: 'name', header: 'Schedule' }, currencyColumn('value', 'Amount'), { field: 'cadence', header: 'Cadence' },
      { field: 'next', header: 'Next date' }, { field: 'state', header: 'State' },
    ]),
    rows: this.list().map((row) => ({ ...row, value: tableMoney(row.amount) })),
    actions: [{ id: 'review', icon: 'pi pi-pencil', tooltip: (row) => 'Review ' + row.name, handler: (row) => this.edit(row) }],
  }));
  editorVisible = true;
  draft: Schedule | null = null;
  amount = '';
  constructor() { void this.ui.load(async () => this.list.set(await this.ui.api.schedules())); }
  edit(row: Schedule) { this.draft = { ...row }; this.amount = moneyText(row.amount); this.showEditor(); }
  private showEditor() { this.editorVisible = true; revealPageSidebar('schedule-editor'); }
  newSchedule() {
    this.draft = { fingerprint: 'manual:' + crypto.randomUUID(), name: '', amount: 0, next: currentDate(),
      cadence: 'monthly', state: 'suggested', evidence: [] };
    this.amount = '';
    this.showEditor();
  }
  evidenceGrid(row: Schedule): GridData {
    return {
      columns: sortableColumns([
        { field: 'date', header: 'Date' }, { field: 'description', header: 'Description' }, currencyColumn('value', 'Amount'),
      ]),
      rows: row.evidence.map((entry) => ({ ...entry, value: tableMoney(entry.amount) })),
    };
  }
  save(row: Schedule, state: 'confirmed' | 'dismissed') {
    return this.ui.run(async () => {
      this.list.set(await this.ui.api.saveSchedule({ ...row, amount: state === 'dismissed' ? row.amount : money(this.amount), state }));
      this.draft = null;
    }, state === 'dismissed' ? 'Schedule dismissed.' : 'Schedule confirmed.');
  }
}
