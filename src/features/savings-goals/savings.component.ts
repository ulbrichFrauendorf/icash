import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, IInputText, ISelect, ITag, NoContentComponent } from 'invensys-ng';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Requests } from '../../shared/api';
import { ZarPipe } from '../../shared/ui/pipes';
import { currentDate, money, moneyText, Ui } from '../../shared/ui/state';
import type { Goal } from './contract';

@Component({
  selector: 'icash-savings',
  imports: [FormsModule, ZarPipe, IButton, IInputText, ISelect, ICard, ITag, NoContentComponent],
  templateUrl: './savings.component.html',
})
export class SavingsPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
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
  progress(goal: Goal) { return Math.round(goal.progress / goal.target * 100) + '%'; }
  edit(goal: Goal) { this.draft = { ...goal, target: moneyText(goal.target), due: goal.due ?? '' }; }
  reset() { this.draft = { name: '', target: '', due: '' }; }
  save() {
    return this.ui.run(async () => {
      this.goals.set(await this.ui.api.saveGoal({ ...this.draft, due: this.draft.due || null, target: money(this.draft.target) }));
      this.reset();
    }, 'Savings goal saved.');
  }
  readonly transferLabel = (pair: Requests['goalTransfers'][1][number]) => pair.date + ' · ' + pair.label + ' · R ' + moneyText(pair.amount);
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
    return this.ui.confirm('Remove this movement from the savings goal?', () => {
      void this.ui.run(async () => {
        this.goals.set(await this.ui.api.removeGoalEntry({ id }));
        this.transfers.set(await this.ui.api.goalTransfers());
      }, 'Savings movement removed.');
    }, 'danger');
  }
}
