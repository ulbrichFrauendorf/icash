import { inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ConfirmationDialogService } from 'invensys-ng';
import { screenPaths, type Screen } from './navigation';
import { PageHistory } from './history';
import type { Api, IpcResult } from '../api';
import type { ProfileState } from '../../features/profiles/contract';
import type { Filters } from '../../features/transactions/contract';
import { decimalMoney, localDate, parseMoney } from '../finance';
import { budgetMonth } from '../../features/monthly-budget/domain';

type Bridge = Record<keyof Api, (input?: unknown) => Promise<IpcResult<unknown>>>;

@Injectable({ providedIn: 'root' })
export class Ui {
  readonly profiles = signal<ProfileState>({ profiles: [], active: null });
  private readonly router = inject(Router);
  private readonly confirmation = inject(ConfirmationDialogService);
  readonly history = inject(PageHistory);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly info = signal('');
  readonly month = signal(budgetMonth(localDate(), 25));
  readonly api = new Proxy({} as Api, {
    get: (_, key: keyof Api) => async (input?: unknown) => {
      const bridge = (window as Window & { icash?: Bridge }).icash;
      if (!bridge) throw new Error('Open iCash from the desktop application.');
      const response = await bridge[key](input);
      if (!response.ok) throw new Error(response.error);
      return response.data;
    },
  });

  go(screen: Screen, filters: Filters = {}) {
    this.error.set('');
    this.info.set('');
    const queryParams = screen === 'Transactions'
      ? { ...filters, categoryId: filters.categoryId === null ? 'uncategorized' : filters.categoryId }
      : undefined;
    void this.router.navigate(['/', screenPaths[screen]], { queryParams });
  }

  state(state: ProfileState, returnToOverview = true) {
    const previous = this.profiles().active;
    const today = localDate();
    const currentMonth = budgetMonth(today, state.active?.payDay ?? 25);
    if (this.month() === budgetMonth(today, previous?.payDay ?? 25)) this.month.set(currentMonth);
    if (previous?.id !== state.active?.id) {
      this.history.reset();
      if (returnToOverview) void this.router.navigateByUrl('/overview', { replaceUrl: true });
    }
    this.profiles.set(state);
  }

  setTheme(theme: 'light' | 'dark') {
    return this.run(async () => this.state(await this.api.setTheme({ theme })));
  }

  confirm(message: string, accept: () => void, severity: 'primary' | 'danger' = 'primary') {
    return this.confirmation.confirm({ message, header: 'Confirm action', severity, accept });
  }

  async run(action: () => Promise<unknown>, message = '') {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.info.set('');
    try {
      await action();
      if (message) this.info.set(message);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'The operation could not be completed.');
    } finally { this.busy.set(false); }
  }

  async load(action: () => Promise<unknown>) {
    try { await action(); }
    catch (error) { this.error.set(error instanceof Error ? error.message : 'The requested data could not be loaded.'); }
  }
}

export const money = (value: string) => parseMoney(value, '.');
export const moneyText = decimalMoney;
export const currentDate = localDate;
