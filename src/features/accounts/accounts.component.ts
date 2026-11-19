import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, ICheckbox, IInputText, ISelect, ITable, PageHeaderActionsDirective, PageHeaderContentDirective, PageLayoutComponent, PageRightSidebarDirective, type GridData } from 'invensys-ng';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui } from '../../shared/ui/state';
import { revealPageSidebar } from '../../shared/ui/navigation';
import { sortableColumns } from '../../shared/ui/table-columns';
import type { Account } from './contract';

@Component({
  selector: 'icash-accounts',
  imports: [FormsModule, IButton, IInputText, ISelect, ICheckbox, ICard, ITable, PageLayoutComponent, PageHeaderActionsDirective, PageHeaderContentDirective, PageRightSidebarDirective],
  templateUrl: './accounts.component.html',
})
export class AccountsPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly accounts = signal<Account[]>([]);
  readonly grid = computed((): GridData<Account> => ({
    columns: sortableColumns([
      { field: 'name', header: 'Account' }, { field: 'kind', header: 'Type' }, { field: 'status', header: 'Status' },
    ]),
    rows: this.accounts().map((row) => ({ ...row, status: row.archived ? 'Archived' : 'Active' })),
    actions: [{ id: 'edit', icon: 'pi pi-pencil', tooltip: (row) => 'Edit ' + row.name, handler: (row) => this.edit(row) }],
  }));
  editorVisible = true;
  draft: { id?: string; name: string; kind: Account['kind']; archived: boolean } = { name: '', kind: 'current', archived: false };
  coverageAccount = '';
  start = '';
  end = '';
  constructor() { void this.ui.load(async () => this.accounts.set(await this.ui.api.accounts())); }
  edit(account: Account) { this.draft = { ...account, archived: Boolean(account.archived) }; this.showEditor(); }
  add() { this.reset(); this.showEditor(); }
  private showEditor() { this.editorVisible = true; revealPageSidebar('account-editor'); }
  reset() { this.draft = { name: '', kind: 'current', archived: false }; }
  save() {
    return this.ui.run(async () => {
      this.accounts.set(await this.ui.api.saveAccount(this.draft));
      this.reset();
    }, 'Account saved.');
  }
  confirm() {
    return this.ui.run(() => this.ui.api.confirmCoverage({ accountId: this.coverageAccount, start: this.start, end: this.end }), 'Statement coverage confirmed.');
  }
}
