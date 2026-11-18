import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui, money, moneyText } from '../../shared/ui/state';
import type { Account } from '../accounts/contract';
import type { Category } from '../categories/contract';
import type { Rule, RulePreview } from './contract';

const blank = () => ({
  id: undefined as string | undefined, name: '', categoryId: '', priority: 100, enabled: true,
  field: 'description' as 'description' | 'merchant', operator: 'contains' as Rule['conditions']['operator'],
  text: '', direction: '' as '' | 'debit' | 'credit', accountId: '', minimum: '', maximum: '',
});

@Component({
  selector: 'icash-rules',
  imports: [FormsModule],
  template: `
    <div class="page-heading"><div><h1>Categorization rules</h1><p>Define how iCash classifies future transactions.</p></div></div>
    <div class="split-grid">
      <section class="panel stack">
        <h2>Rules</h2>
        <p class="muted">User rules run before merchant mappings and defaults. Lower priority numbers run first.</p>
        @for (rule of rules(); track rule.id) {
          <div class="list-row"><div><strong>{{ rule.name }}</strong><div class="muted">{{ categoryName(rule.categoryId) }} · {{ rule.source }} · priority {{ rule.priority }}{{ rule.enabled ? '' : ' · disabled' }}</div></div>
            <button (click)="edit(rule)">Edit</button></div>
        } @empty { <p class="empty">Create a rule to categorize a recurring merchant or payment.</p> }
      </section>
      <div class="stack">
        <form class="panel stack" (ngSubmit)="save()">
          <h2>{{ draft.id ? 'Edit rule' : 'New rule' }}</h2>
          <label>Rule name <input name="name" [(ngModel)]="draft.name" required maxlength="80"></label>
          <label>Target category <select name="category" [(ngModel)]="draft.categoryId"><option value="">Select category</option>
            @for (category of categories(); track category.id) { <option [value]="category.id">{{ categoryName(category.id) }}</option> }
          </select></label>
          <div class="field-grid">
            <label>Field <select name="field" [(ngModel)]="draft.field"><option value="description">Description</option><option value="merchant">Merchant</option></select></label>
            <label>Operator <select name="operator" [(ngModel)]="draft.operator"><option value="contains">Contains</option><option value="equals">Equals</option><option value="startsWith">Starts with</option></select></label>
            <label>Matching text <input name="text" [(ngModel)]="draft.text" maxlength="200"></label>
            <label>Direction <select name="direction" [(ngModel)]="draft.direction"><option value="">Any</option><option value="debit">Debit</option><option value="credit">Credit</option></select></label>
            <label>Account <select name="account" [(ngModel)]="draft.accountId"><option value="">Any account</option>
              @for (account of accounts(); track account.id) { <option [value]="account.id">{{ account.name }}</option> }
            </select></label>
            <label>Minimum (R) <input name="min" [(ngModel)]="draft.minimum" inputmode="decimal"></label>
            <label>Maximum (R) <input name="max" [(ngModel)]="draft.maximum" inputmode="decimal"></label>
            <label>Priority <input name="priority" type="number" min="0" max="9999" [(ngModel)]="draft.priority"></label>
          </div>
          <label class="check"><input name="enabled" type="checkbox" [(ngModel)]="draft.enabled"> Rule enabled</label>
          <div class="actions">
            <button type="submit" class="primary" [disabled]="ui.busy() || !draft.name.trim() || !draft.categoryId">Save rule</button>
            @if (draft.id) {
              <button type="button" (click)="reset()">Cancel</button>
              <button type="button" class="danger" [disabled]="ui.busy()" (click)="remove()">Delete rule</button>
            }
          </div>
        </form>
        <section class="panel stack">
          <h2>Apply to previous transactions</h2>
          <button [disabled]="ui.busy()" (click)="previewRules()">Preview rule changes</button>
          @if (preview(); as result) {
            <p>{{ result.changes }} changed · {{ result.protected }} manual assignments protected · {{ result.conflicts }} overlapping matches</p>
            <div class="review-table">
            @for (row of result.sample; track row.id) {
              <div class="list-row">{{ row.description }} · {{ categoryName(row.from) }} → {{ categoryName(row.to) }}</div>
            }
            </div>
            <button class="primary" [disabled]="ui.busy() || !result.changes" (click)="applyRules(result)">Apply reviewed changes</button>
          }
        </section>
      </div>
    </div>
  `,
})
export class RulesPage {
  readonly ui = inject(Ui);
  readonly categories = signal<Category[]>([]);
  readonly accounts = signal<Account[]>([]);
  readonly rules = signal<Rule[]>([]);
  readonly preview = signal<RulePreview | null>(null);
  draft = blank();
  constructor() {
    void this.ui.load(async () => {
      const [rules, categories, accounts] = await Promise.all([this.ui.api.rules(), this.ui.api.categories(), this.ui.api.accounts()]);
      this.rules.set(rules);
      this.categories.set(categories.filter((item) => item.leaf && !item.archived));
      this.accounts.set(accounts);
    });
  }
  categoryName(id: string | null) {
    return this.categories().find((item) => item.id === id)?.name ?? 'Uncategorized';
  }
  reset() { this.draft = blank(); }
  edit(rule: Rule) {
    this.draft = { ...rule, ...rule.conditions, text: rule.conditions.text ?? '', accountId: rule.conditions.accountId ?? '',
      direction: rule.conditions.direction ?? '',
      minimum: rule.conditions.minimum === undefined ? '' : moneyText(rule.conditions.minimum),
      maximum: rule.conditions.maximum === undefined ? '' : moneyText(rule.conditions.maximum) };
  }
  save() {
    return this.ui.run(async () => {
      this.rules.set(await this.ui.api.saveRule({ ...this.draft, conditions: {
        field: this.draft.field, operator: this.draft.operator, text: this.draft.text.trim() || undefined,
        direction: this.draft.direction || undefined, accountId: this.draft.accountId || undefined,
        minimum: this.draft.minimum ? money(this.draft.minimum) : undefined, maximum: this.draft.maximum ? money(this.draft.maximum) : undefined,
      } }));
      this.reset(); this.preview.set(null);
    }, 'Rule saved.');
  }
  remove() {
    if (!this.draft.id || !window.confirm('Delete this categorization rule?')) return;
    const id = this.draft.id;
    return this.ui.run(async () => { this.rules.set(await this.ui.api.deleteRule({ id })); this.reset(); this.preview.set(null); }, 'Rule deleted.');
  }
  previewRules() { return this.ui.run(async () => this.preview.set(await this.ui.api.previewRules())); }
  applyRules(preview: RulePreview) {
    return this.ui.run(async () => { await this.ui.api.applyRules({ preview }); this.preview.set(null); }, 'Reviewed changes applied.');
  }
}
