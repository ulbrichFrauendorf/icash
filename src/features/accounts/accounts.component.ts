import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IButton, ICheckbox, IInputText, ISelect, ITable, PageHeaderActionsDirective, PageHeaderContentDirective, PageLayoutComponent, IDialog, type GridData } from 'invensys-ng';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui } from '../../shared/ui/state';
import { sortableColumns } from '../../shared/ui/table-columns';
import type { Account } from './contract';

@Component({
  selector: 'icash-accounts',
  imports: [FormsModule, IButton, IInputText, ISelect, ICheckbox, ITable, PageLayoutComponent, PageHeaderActionsDirective, PageHeaderContentDirective, IDialog],
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
  editorVisible = false;
  draft: { id?: string; name: string; kind: Account['kind']; archived: boolean } = { name: '', kind: 'current', archived: false };
  constructor() { void this.ui.load(async () => this.accounts.set(await this.ui.api.accounts())); }
  edit(account: Account) { this.draft = { ...account, archived: Boolean(account.archived) }; this.showEditor(); }
  add() { this.reset(); this.showEditor(); }
  private showEditor() { this.editorVisible = true; }
  reset() { this.draft = { name: '', kind: 'current', archived: false }; }
  save() {
    return this.ui.run(async () => {
      this.accounts.set(await this.ui.api.saveAccount(this.draft));
      this.editorVisible = false;
    }, 'Account saved.');
  }
}
