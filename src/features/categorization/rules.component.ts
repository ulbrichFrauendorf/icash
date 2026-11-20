import { reviewCategoryChoices } from '../../shared/ui/category-choices';
import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, ICheckbox, IDialog, IMessage, IInputText, ISelect, ITable, PageHeaderActionsDirective, PageHeaderContentDirective, PageLayoutComponent, type GridData } from 'invensys-ng';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui, money, moneyText } from '../../shared/ui/state';
import { sortableColumns } from '../../shared/ui/table-columns';
import type { AiRule, AiRules, CategoryChoice } from '../openai/contract';
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
  imports: [FormsModule, IButton, IInputText, ISelect, ICheckbox, ICard, IDialog, IMessage, ITable, PageLayoutComponent, PageHeaderActionsDirective, PageHeaderContentDirective],
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
  readonly aiRule = signal<AiRule | null>(null);
  readonly selectedRules = signal<Map<number, CategoryChoice>>(new Map());
  readonly grid = computed((): GridData<Rule> => ({
    columns: sortableColumns([
      { field: 'name', header: 'Rule' }, { field: 'categoryName', header: 'Category' },
      { field: 'source', header: 'Source' }, { field: 'priority', header: 'Priority', type: 'number' },
      { field: 'status', header: 'Status' },
    ]),
    rows: this.rules().map((row) => ({ ...row, categoryName: this.categoryName(row.categoryId), status: row.enabled ? 'Enabled' : 'Disabled' })),
    actions: [{ id: 'edit', icon: 'pi pi-pencil', tooltip: (row) => 'Edit ' + row.name, handler: (row) => this.edit(row) }],
  }));
  readonly previewGrid = computed((): GridData => ({
    columns: sortableColumns([
      { field: 'description', header: 'Description' }, { field: 'fromName', header: 'Current category' }, { field: 'toName', header: 'New category' },
    ]),
    rows: (this.preview()?.sample ?? []).map((row) => ({ ...row, fromName: this.categoryName(row.from), toName: this.categoryName(row.to) })),
  }));
  readonly aiGrid = computed((): GridData<AiRule> => ({
    columns: sortableColumns([
      { field: 'name', header: 'Rule' }, { field: 'match', header: 'Description contains' },
      { field: 'direction', header: 'Direction' }, { field: 'samples', header: 'Samples', type: 'number' },
      { field: 'categoryLabel', header: 'Category' },
    ]),
    rows: (this.aiDraft()?.rules ?? []).map((row) => {
      const choice = this.selectedRules().get(row.index);
      return { ...row,
        categoryLabel: choice === 'suggested' ? row.category.label : choice ? this.categoryName(choice) : 'Skip rule' };
    }),
    actions: [{ id: 'category', icon: 'pi pi-pencil', tooltip: (row) => 'Change category for ' + row.match,
      handler: (row) => this.aiRule.set(row) }],
  }));
  editorVisible = false;
  draft = blank();
  constructor() {
    void this.ui.load(async () => {
      const [rules, categories, accounts] = await Promise.all([this.ui.api.rules(), this.ui.api.categories(), this.ui.api.accounts()]);
      this.rules.set(rules);
      this.categories.set(categories);
      this.accounts.set(accounts);
    });
  }
  readonly categoryLabel = (category: Category) => this.categoryName(category.id);
  editableCategories() { return this.categories().filter((item) => item.leaf && !item.archived); }
  categoryName(id: string | null) {
    const category = this.categories().find((item) => item.id === id);
    const group = category && this.categories().find((item) => item.id === category.parentId);
    return group && category ? group.name + ' / ' + category.name : category?.name ?? 'Uncategorized';
  }
  reset() { this.draft = blank(); }
  add() { this.reset(); this.showEditor(); }
  private showEditor() { this.editorVisible = true; }
  edit(rule: Rule) {
    this.draft = { ...rule, ...rule.conditions, text: rule.conditions.text ?? '', accountId: rule.conditions.accountId ?? '',
      direction: rule.conditions.direction ?? '',
      minimum: rule.conditions.minimum === undefined ? '' : moneyText(rule.conditions.minimum),
      maximum: rule.conditions.maximum === undefined ? '' : moneyText(rule.conditions.maximum) };
    this.showEditor();
  }
  save() {
    return this.ui.run(async () => {
      const { id, name, categoryId, priority, enabled } = this.draft;
      this.rules.set(await this.ui.api.saveRule({ id, name, categoryId, priority, enabled, conditions: {
        field: this.draft.field, operator: this.draft.operator, text: this.draft.text.trim() || undefined,
        direction: this.draft.direction || undefined, accountId: this.draft.accountId || undefined,
        minimum: this.draft.minimum ? money(this.draft.minimum) : undefined, maximum: this.draft.maximum ? money(this.draft.maximum) : undefined,
      } }));
      this.editorVisible = false; this.preview.set(null);
    }, 'Rule saved.');
  }
  remove() {
    if (!this.draft.id) return;
    const id = this.draft.id;
    return this.ui.confirm('Delete this categorization rule?', () => {
      void this.ui.run(async () => { this.rules.set(await this.ui.api.deleteRule({ id })); this.editorVisible = false; this.preview.set(null); }, 'Rule deleted.');
    }, 'danger');
  }
  suggestRules() {
    return this.ui.run(async () => {
      const result = await this.ui.api.suggestAiRules();
      if (!result.rules.length) {
        this.ui.info.set('No new rules could be suggested for uncategorized transactions.');
        return;
      }
      this.selectedRules.set(new Map(result.rules.map((rule) => [rule.index, 'suggested'])));
      this.aiRule.set(result.rules[0] ?? null);
      this.aiDraft.set(result);
    });
  }
  categoryOptions(rule: AiRule) {
    return reviewCategoryChoices(this.categories(), rule.category.kind, 'Skip rule', rule.category);
  }
  selectRule(index: number, choice: CategoryChoice) {
    this.selectedRules.update((selected) => new Map(selected).set(index, choice));
  }
  hasSelectedRules() { return [...this.selectedRules().values()].some(Boolean); }
  closeAiRules() { this.aiDraft.set(null); this.aiRule.set(null); }
  saveAiRules(draft: AiRules, applyToImported: boolean) {
    return this.ui.run(async () => {
      const result = await this.ui.api.applyAiRules({
        token: draft.token, applyToImported,
        selected: [...this.selectedRules()].flatMap(([index, choice]) => choice ? [{ index, choice }] : []),
      });
      this.rules.set(result.rules);
      this.categories.set(await this.ui.api.categories());
      this.preview.set(null);
      this.closeAiRules();
      const rules = result.created === 1 ? 'rule' : 'rules';
      const transactions = result.classified === 1 ? 'transaction' : 'transactions';
      this.ui.info.set(`Saved ${result.created} ${rules} and categorized ${result.classified} imported ${transactions}.`);
    });
  }
  previewRules() { return this.ui.run(async () => this.preview.set(await this.ui.api.previewRules())); }
  applyRules(preview: RulePreview) {
    return this.ui.run(async () => {
      const result = await this.ui.api.applyRules({ preview });
      this.preview.set(null);
      this.ui.info.set(result.changes === 1 ? 'Updated 1 transaction.' : `Updated ${result.changes} transactions.`);
    });
  }
}
