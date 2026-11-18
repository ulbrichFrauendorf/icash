import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ZarPipe } from '../../shared/ui/pipes';
import { currentDate, money, moneyText, Ui } from '../../shared/ui/state';
import type { Schedule } from './contract';

@Component({
  selector: 'icash-recurring',
  imports: [FormsModule, ZarPipe],
  template: `
    <div class="page-heading"><div><h1>Recurring activity</h1><p>Review subscriptions, bills, and regular income. Confirmed schedules appear in forecasts.</p></div>
      <button (click)="newSchedule()">Add schedule</button></div>
    <div class="split-grid">
      <section class="panel stack">
        <h2>Schedules</h2>
        @for (row of list(); track row.fingerprint) {
          <div class="list-row"><div><strong>{{ row.name }}</strong><div class="muted">{{ row.amount | zar }} · {{ row.cadence }} · {{ row.next }} · {{ row.state }}</div></div>
            <button (click)="edit(row)">Review</button></div>
        } @empty { <p class="empty">iCash suggests schedules after three comparable weekly or monthly payments.</p> }
      </section>
      @if (draft; as row) {
        <section class="panel stack">
          <h2>{{ row.name || 'New schedule' }}</h2>
          <label>Name <input [(ngModel)]="row.name" maxlength="80"></label>
          <label>Signed amount (R) <input [(ngModel)]="amount" inputmode="decimal"></label>
          <label>Cadence <select [(ngModel)]="row.cadence"><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
          <label>Next expected date <input type="date" [(ngModel)]="row.next"></label>
          @if (row.evidence.length) { <h3>Recent evidence</h3> }
          @for (item of row.evidence; track $index) { <p>{{ item.date }} · {{ item.description }} · {{ item.amount | zar }}</p> }
          <div class="actions">
            <button class="primary" [disabled]="!row.name.trim() || !amount || !row.next || ui.busy()" (click)="save(row, 'confirmed')">Confirm schedule</button>
            @if (row.amount) { <button [disabled]="ui.busy()" (click)="save(row, 'dismissed')">Dismiss</button> }
            <button (click)="draft = null">Cancel</button>
          </div>
        </section>
      }
    </div>
  `,
})
export class RecurringPage {
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
