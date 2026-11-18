import { inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ConfirmationDialogService } from 'invensys-ng';
import { screenPaths, type Screen } from './navigation';
import type { Api, IpcResult } from '../api';
import type { ProfileState } from '../../features/profiles/contract';
import type { Filters } from '../../features/transactions/contract';
import { decimalMoney, localDate, parseMoney } from '../finance';

type Bridge = Record<keyof Api, (input?: unknown) => Promise<IpcResult<unknown>>>;

@Injectable({ providedIn: 'root' })
export class Ui {
  readonly profiles = signal<ProfileState>({ profiles: [], active: null });
  private readonly router = inject(Router);
  private readonly confirmation = inject(ConfirmationDialogService);
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
    void this.router.navigateByUrl('/' + screenPaths[screen]);
  }

  state(state: ProfileState, returnToOverview = true) {
    if (this.profiles().active?.id !== state.active?.id) {
      this.transactionFilter.set({});
      if (returnToOverview) void this.router.navigateByUrl('/overview');
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
