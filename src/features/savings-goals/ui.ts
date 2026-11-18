import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Requests } from '../../shared/api';
import { ZarPipe } from '../../shared/ui/pipes';
import { currentDate, money, moneyText, Ui } from '../../shared/ui/state';
import type { Goal } from './contract';

@Component({
  selector: 'icash-savings',
  imports: [FormsModule, ZarPipe],
  template: `
    <div class="page-heading"><div><h1>Savings goals</h1><p>Track contributions toward household goals, independently of spending.</p></div></div>
    <div class="split-grid">
      <section class="panel stack"><h2>Your goals</h2>
        @for (goal of goals(); track goal.id) {
          <section class="stack goal">
            <div class="section-header"><h3>{{ goal.name }}</h3><button (click)="edit(goal)">Edit goal</button></div>
            <p>{{ goal.progress | zar }} of {{ goal.target | zar }}{{ goal.due ? ' · Due ' + goal.due : '' }}</p>
            <progress [value]="progress(goal)" [max]="goal.target" [attr.aria-label]="goal.name + ' progress'"></progress>
            @for (entry of goal.entries; track entry.id) {
              <div class="list-row"><span>{{ entry.date }} · {{ entry.amount | zar }}{{ entry.pairId ? ' · Paired transfer' : '' }}</span>
                <button [disabled]="ui.busy()" (click)="remove(entry.id)">Remove</button></div>
            }
          </section>
        } @empty { <p class="empty">Set a target for an emergency fund, holiday, or another goal.</p> }
      </section>
      <div class="stack">
        <form class="panel stack" (ngSubmit)="save()">
          <h2>{{ draft.id ? 'Edit goal' : 'New goal' }}</h2>
          <label>Goal name <input name="name" [(ngModel)]="draft.name" maxlength="80" required></label>
          <label>Target amount (R) <input name="target" [(ngModel)]="draft.target" inputmode="decimal" required></label>
          <label>Target date <input name="date" [(ngModel)]="draft.due" type="date"></label>
          <div class="actions"><button class="primary" type="submit" [disabled]="ui.busy() || !draft.name.trim() || !draft.target">Save goal</button>
            @if (draft.id) { <button type="button" (click)="reset()">Cancel</button> }</div>
        </form>
        @if (goals().length) {
          <section class="panel stack"><h2>Record savings movement</h2>
            <label>Goal <select [(ngModel)]="goalId"><option value="">Select goal</option>
              @for (goal of goals(); track goal.id) { <option [value]="goal.id">{{ goal.name }}</option> }</select></label>
            <label>Link a paired transfer <select [(ngModel)]="pairId" (ngModelChange)="chooseTransfer($event)"><option value="">Manual entry</option>
              @for (pair of transfers(); track pair.id) { <option [value]="pair.id">{{ pair.date }} · {{ pair.label }} · {{ pair.amount | zar }}</option> }</select></label>
            <label>Signed amount (R) <input [(ngModel)]="amount" inputmode="decimal" placeholder="Use a negative amount for a withdrawal"></label>
            <label>Entry date <input [(ngModel)]="date" type="date"></label>
            <button class="primary" [disabled]="ui.busy() || !goalId || !amount || !date" (click)="contribute()">Record movement</button>
          </section>
        }
      </div>
    </div>
  `,
})
export class SavingsPage {
  readonly ui = inject(Ui);
  readonly goals = signal<Goal[]>([]);
  readonly transfers = signal<Requests['goalTransfers'][1]>([]);
  draft: { id?: string; name: string; target: string; due: string } = { name: '', target: '', due: '' };
  goalId = '';
  pairId = '';
  amount = '';
  date = currentDate();
  constructor() {
    void this.ui.load(async () => {
      const [goals, transfers] = await Promise.all([this.ui.api.goals(), this.ui.api.goalTransfers()]);
      this.goals.set(goals); this.transfers.set(transfers);
    });
  }
  progress(goal: Goal) { return Math.max(0, Math.min(goal.progress, goal.target)); }
  edit(goal: Goal) { this.draft = { ...goal, target: moneyText(goal.target), due: goal.due ?? '' }; }
  reset() { this.draft = { name: '', target: '', due: '' }; }
  save() {
    return this.ui.run(async () => {
      this.goals.set(await this.ui.api.saveGoal({ ...this.draft, due: this.draft.due || null, target: money(this.draft.target) }));
      this.reset();
    }, 'Savings goal saved.');
  }
  chooseTransfer(id: string) {
    const pair = this.transfers().find((row) => row.id === id);
    if (pair) { this.amount = moneyText(pair.amount); this.date = pair.date; }
  }
  contribute() {
    return this.ui.run(async () => {
      this.goals.set(await this.ui.api.saveGoalEntry({ goalId: this.goalId, pairId: this.pairId || null, amount: money(this.amount), date: this.date }));
      this.transfers.set(await this.ui.api.goalTransfers());
      this.amount = ''; this.pairId = '';
    }, 'Savings movement recorded.');
  }
  remove(id: string) {
    if (!window.confirm('Remove this movement from the savings goal?')) return;
    return this.ui.run(async () => {
      this.goals.set(await this.ui.api.removeGoalEntry({ id }));
      this.transfers.set(await this.ui.api.goalTransfers());
    }, 'Savings movement removed.');
  }
}
