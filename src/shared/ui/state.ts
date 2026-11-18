import { Injectable, signal } from '@angular/core';
import type { Api, IpcResult } from '../api';
import type { ProfileState } from '../../features/profiles/contract';
import type { Filters } from '../../features/transactions/contract';
import { decimalMoney, localDate, parseMoney } from '../finance';

export type Screen = 'Overview' | 'Accounts' | 'Import' | 'Transactions' | 'Categories' | 'Rules' | 'Budgets' | 'Recurring' | 'Savings' | 'Reports' | 'Settings';
type Bridge = Record<keyof Api, (input?: unknown) => Promise<IpcResult<unknown>>>;

@Injectable({ providedIn: 'root' })
export class Ui {
  readonly profiles = signal<ProfileState>({ profiles: [], active: null });
  readonly screen = signal<Screen>('Overview');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly info = signal('');
  readonly month = signal(localDate().slice(0, 7));
  readonly transactionFilter = signal<Filters>({});
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
    if (screen === 'Transactions') this.transactionFilter.set(filters);
    this.screen.set(screen);
  }

  state(state: ProfileState) {
    if (this.profiles().active?.id !== state.active?.id) {
      this.transactionFilter.set({});
      this.screen.set('Overview');
    }
    this.profiles.set(state);
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
