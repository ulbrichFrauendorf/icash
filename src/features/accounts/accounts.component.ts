import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, ICheckbox, IInputText, ISelect, NoContentComponent } from 'invensys-ng';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui } from '../../shared/ui/state';
import type { Account } from './contract';

@Component({
  selector: 'icash-accounts',
  imports: [FormsModule, IButton, IInputText, ISelect, ICheckbox, ICard, NoContentComponent],
  templateUrl: './accounts.component.html',
})
export class AccountsPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly accounts = signal<Account[]>([]);
  draft: { id?: string; name: string; kind: Account['kind']; archived: boolean } = { name: '', kind: 'current', archived: false };
  coverageAccount = '';
  start = '';
  end = '';
  constructor() { void this.ui.load(async () => this.accounts.set(await this.ui.api.accounts())); }
  edit(account: Account) { this.draft = { ...account, archived: Boolean(account.archived) }; }
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
