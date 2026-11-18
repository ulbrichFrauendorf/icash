import { Component, inject } from '@angular/core';
import { AccountsPage } from '../../features/accounts/ui';
import { CategoriesPage } from '../../features/categories/ui';
import { RulesPage } from '../../features/categorization/ui';
import { ImportPage } from '../../features/import-statement/ui';
import { BudgetsPage } from '../../features/monthly-budget/ui';
import { ProfilesPage, SettingsPage } from '../../features/profiles/ui';
import { RecurringPage } from '../../features/recurring/ui';
import { ReportsPage } from '../../features/reports/ui';
import { SavingsPage } from '../../features/savings-goals/ui';
import { TransactionsPage } from '../../features/transactions/ui';
import { Ui, type Screen } from '../../shared/ui/state';

@Component({
  selector: 'icash-app',
  imports: [AccountsPage, CategoriesPage, RulesPage, ImportPage, BudgetsPage, ProfilesPage,
    SettingsPage, RecurringPage, ReportsPage, SavingsPage, TransactionsPage],
  template: `
    <div class="app" [attr.data-theme]="ui.profiles().active?.theme || 'light'">
      @if (ui.profiles().active; as profile) {
        <div class="layout">
          <aside class="sidebar">
            <button class="brand" (click)="ui.go('Overview')" aria-label="iCash overview"><span class="brand-mark">i</span>iCash</button>
            <div class="household"><span class="household-icon" aria-hidden="true">{{ profile.name.slice(0, 1).toUpperCase() }}</span><div><strong>{{ profile.name }}</strong><span>Household</span></div></div>
            <nav aria-label="Main navigation">
              @for (link of links; track link.screen) {
                <button [class.current]="ui.screen() === link.screen" [attr.aria-current]="ui.screen() === link.screen ? 'page' : null"
                  (click)="ui.go(link.screen)" [disabled]="ui.busy()"><span aria-hidden="true" class="nav-icon">{{ link.icon }}</span>{{ link.label }}</button>
              }
            </nav>
            <div class="local-status"><span class="status-dot"></span>Offline · ZAR</div>
          </aside>
          <main class="content">
            @if (ui.error()) { <div class="notification error" role="alert">{{ ui.error() }}</div> }
            @if (ui.info()) { <div class="notification success" role="status">{{ ui.info() }}</div> }
            @switch (ui.screen()) {
              @case ('Overview') { <icash-reports/> }
              @case ('Accounts') { <icash-accounts/> }
              @case ('Import') { <icash-import/> }
              @case ('Transactions') { <icash-transactions/> }
              @case ('Categories') { <icash-categories/> }
              @case ('Rules') { <icash-rules/> }
              @case ('Budgets') { <icash-budgets/> }
              @case ('Recurring') { <icash-recurring/> }
              @case ('Savings') { <icash-savings/> }
              @case ('Reports') { <icash-reports [detailed]="true"/> }
              @case ('Settings') { <icash-settings/> }
            }
          </main>
        </div>
      } @else {
        @if (ui.error()) { <div class="notification error welcome-status" role="alert">{{ ui.error() }}</div> }
        <icash-profiles/>
      }
    </div>
  `,
})
export class App {
  readonly ui = inject(Ui);
  readonly links: { screen: Screen; label: string; icon: string }[] = [
    { screen: 'Overview', label: 'Overview', icon: '▦' }, { screen: 'Accounts', label: 'Accounts', icon: '▤' },
    { screen: 'Transactions', label: 'Transactions', icon: '⇄' }, { screen: 'Import', label: 'Import statements', icon: '↓' },
    { screen: 'Budgets', label: 'Budgets', icon: '◫' }, { screen: 'Categories', label: 'Categories', icon: '◇' },
    { screen: 'Rules', label: 'Rules', icon: '≡' }, { screen: 'Recurring', label: 'Recurring', icon: '↻' },
    { screen: 'Savings', label: 'Savings goals', icon: '◎' }, { screen: 'Reports', label: 'Reports', icon: '▥' },
    { screen: 'Settings', label: 'Settings', icon: '⚙' },
  ];
  constructor() { void this.ui.load(async () => this.ui.state(await this.ui.api.getProfiles())); }
}
