import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui } from '../../shared/ui/state';
import type { Account } from './contract';

@Component({
  selector: 'icash-accounts',
  imports: [FormsModule],
  template: `
    <div class="page-heading"><div><h1>Accounts</h1><p>Set up the bank accounts and cards in this household.</p></div>
      <button class="primary" (click)="ui.go('Import')">Import statement</button></div>
    <div class="split-grid">
      <section class="panel">
        <h2>Household accounts</h2>
        @if (!accounts().length) { <p class="empty">Add an account to choose where to import your first statement.</p> }
        @for (account of accounts(); track account.id) {
          <div class="list-row"><div><strong>{{ account.name }}</strong><div class="muted">{{ account.kind }}{{ account.archived ? ' · Archived' : '' }}</div></div>
            <button (click)="edit(account)">Edit</button></div>
        }
      </section>
      <form class="panel stack" (ngSubmit)="save()">
        <h2>{{ draft.id ? 'Edit account' : 'Add account' }}</h2>
        <label>Account name <input name="name" [(ngModel)]="draft.name" maxlength="80" required placeholder="e.g. Absa current account"></label>
        <label>Account type <select name="kind" [(ngModel)]="draft.kind">
          <option value="current">Current</option><option value="savings">Savings</option>
          <option value="credit-card">Credit card</option><option value="other">Other</option>
        </select></label>
        @if (draft.id) { <label class="check"><input type="checkbox" name="archived" [(ngModel)]="draft.archived"> Archive account</label> }
        <div class="actions"><button class="primary" type="submit" [disabled]="!draft.name.trim() || ui.busy()">Save account</button>
          @if (draft.id) { <button type="button" (click)="reset()">Cancel</button> }
        </div>
      </form>
      <section class="panel stack">
        <h2>Confirm statement coverage</h2>
        <p>Confirm a date range once all activity for that account is present, including dates with no transactions. iCash uses verified coverage when suggesting budgets.</p>
        <label>Coverage account <select [(ngModel)]="coverageAccount"><option value="">Select account</option>
          @for (a of accounts(); track a.id) { <option [value]="a.id">{{ a.name }}</option> }
        </select></label>
        <div class="field-grid">
          <label>Coverage starts <input type="date" [(ngModel)]="start"></label>
          <label>Coverage ends <input type="date" [(ngModel)]="end"></label>
        </div>
        <button [disabled]="!coverageAccount || !start || !end || ui.busy()" (click)="confirm()">Confirm coverage</button>
      </section>
    </div>
  `,
})
export class AccountsPage {
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
