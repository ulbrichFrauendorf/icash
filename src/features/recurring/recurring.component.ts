import { retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, IInputText, ISelect, NoContentComponent } from 'invensys-ng';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ZarPipe } from '../../shared/ui/pipes';
import { currentDate, money, moneyText, Ui } from '../../shared/ui/state';
import type { Schedule } from './contract';

@Component({
  selector: 'icash-recurring',
  imports: [FormsModule, ZarPipe, IButton, IInputText, ISelect, ICard, NoContentComponent],
  templateUrl: './recurring.component.html',
})
export class RecurringPage {
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly list = signal<Schedule[]>([]);
  draft: Schedule | null = null;
  amount = '';
  constructor() { void this.ui.load(async () => this.list.set(await this.ui.api.schedules())); }
  edit(row: Schedule) { this.draft = { ...row }; this.amount = moneyText(row.amount); }
  newSchedule() {
    this.draft = { fingerprint: 'manual:' + crypto.randomUUID(), name: '', amount: 0, next: currentDate(),
      cadence: 'monthly', state: 'suggested', evidence: [] };
    this.amount = '';
  }
  save(row: Schedule, state: 'confirmed' | 'dismissed') {
    return this.ui.run(async () => {
      this.list.set(await this.ui.api.saveSchedule({ ...row, amount: state === 'dismissed' ? row.amount : money(this.amount), state }));
      this.draft = null;
    }, state === 'dismissed' ? 'Schedule dismissed.' : 'Schedule confirmed.');
  }
}
