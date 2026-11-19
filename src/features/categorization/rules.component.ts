import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, ICheckbox, IDialog, IMessage, IInputText, ISelect, NoContentComponent } from 'invensys-ng';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui, money, moneyText } from '../../shared/ui/state';
import type { AiRules } from '../openai/contract';
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
  imports: [FormsModule, IButton, IInputText, ISelect, ICheckbox, ICard, IDialog, IMessage, NoContentComponent],
  templateUrl: './rules.component.html',
})
export class RulesPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly categories = signal<Category[]>([]);
  readonly accounts = signal<Account[]>([]);
  readonly rules = signal<Rule[]>([]);
  readonly preview = signal<RulePreview | null>(null);
  readonly aiDraft = signal<AiRules | null>(null);
  readonly selectedRules = signal<Set<number>>(new Set());
  applyToImported = true;
  draft = blank();
  constructor() {
    void this.ui.load(async () => {
      const [rules, categories, accounts] = await Promise.all([this.ui.api.rules(), this.ui.api.categories(), this.ui.api.accounts()]);
      this.rules.set(rules);
      this.categories.set(categories.filter((item) => item.leaf && !item.archived));
      this.accounts.set(accounts);
    });
  }
  readonly categoryLabel = (category: Category) => this.categoryName(category.id);
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
    if (!this.draft.id) return;
    const id = this.draft.id;
    return this.ui.confirm('Delete this categorization rule?', () => {
      void this.ui.run(async () => { this.rules.set(await this.ui.api.deleteRule({ id })); this.reset(); this.preview.set(null); }, 'Rule deleted.');
    }, 'danger');
  }
  suggestRules() {
    return this.ui.run(async () => {
      const result = await this.ui.api.suggestAiRules();
      if (!result.rules.length) {
        this.ui.info.set('No new rules could be suggested for uncategorized transactions.');
        return;
      }
      this.applyToImported = true;
      this.selectedRules.set(new Set());
      this.aiDraft.set(result);
    });
  }
  selectRule(index: number, checked: boolean) {
    this.selectedRules.update((selected) => {
      const next = new Set(selected);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }
  saveAiRules(draft: AiRules) {
    return this.ui.run(async () => {
      const result = await this.ui.api.applyAiRules({
        token: draft.token, selected: [...this.selectedRules()], applyToImported: this.applyToImported,
      });
      this.rules.set(result.rules);
      this.categories.set((await this.ui.api.categories()).filter((item) => item.leaf && !item.archived));
      this.preview.set(null);
      this.aiDraft.set(null);
      const rules = result.created === 1 ? 'rule' : 'rules';
      const transactions = result.classified === 1 ? 'transaction' : 'transactions';
      this.ui.info.set(`Saved ${result.created} ${rules} and categorized ${result.classified} imported ${transactions}.`);
    });
  }
  previewRules() { return this.ui.run(async () => this.preview.set(await this.ui.api.previewRules())); }
  applyRules(preview: RulePreview) {
    return this.ui.run(async () => { await this.ui.api.applyRules({ preview }); this.preview.set(null); }, 'Reviewed changes applied.');
  }
}
