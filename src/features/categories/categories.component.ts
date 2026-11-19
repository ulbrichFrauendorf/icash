import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, ICheckbox, IInputText, ISelect, ITable, PageHeaderContentDirective, PageLayoutComponent, PageRightSidebarDirective, IDialog, type GridAction, type GridData } from 'invensys-ng';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui } from '../../shared/ui/state';
import { sortableColumns } from '../../shared/ui/table-columns';
import type { TemplatePreview } from './portable';
import type { CategoryProposal, ImportModeration } from '../import-statement/contract';
import type { Category } from './contract';

type Draft = Omit<Category, 'id' | 'templateKey' | 'leaf'> & { id?: string };
const newCategory = (): Draft => ({ name: '', kind: 'expense', parentId: null, colour: '#278473', icon: '', sort: 0, archived: false, excludeReports: false });

@Component({
  selector: 'icash-categories',
  imports: [FormsModule, IButton, IInputText, ISelect, ICheckbox, ICard, ITable, PageLayoutComponent, PageHeaderContentDirective, PageRightSidebarDirective, IDialog],
  templateUrl: './categories.component.html',
})
export class CategoriesPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly list = signal<Category[]>([]);
  readonly moderation = signal<ImportModeration | null>(null);
  readonly showModeration = signal(false);
  readonly pending = computed(() => this.moderation()?.proposals.filter((proposal) => proposal.status === 'pending').length ?? 0);
  readonly tableHeight = 'max(12rem, calc(100dvh - var(--window-titlebar-height) - 13rem))';
  templatesVisible = true;
  readonly proposalDraft = signal<CategoryProposal | null>(null);
  readonly moderationGrid = computed((): GridData<CategoryProposal> => ({
    columns: sortableColumns([
      { field: 'name', header: 'Category' }, { field: 'group', header: 'Group' },
      { field: 'rows', header: 'Transactions', type: 'number' }, { field: 'state', header: 'Status' },
    ]),
    rows: (this.moderation()?.proposals ?? []).map((row) => ({
      ...row, state: { pending: 'Pending', accepted: 'Accepted', deleted: 'Deleted' }[row.status],
    })),
    actions: [
      { id: 'edit', icon: 'pi pi-pencil', tooltip: (row) => 'Edit proposal for ' + row.name,
        visible: (row) => row.status === 'pending', disabled: () => this.ui.busy(), handler: (row) => { this.proposalDraft.set({ ...row }); } },
      { id: 'accept', icon: 'pi pi-check', severity: 'success', tooltip: (row) => 'Accept ' + row.name,
        visible: (row) => row.status === 'pending', disabled: () => this.ui.busy(), handler: (row) => this.moderate(row, 'accept') },
      { id: 'delete', icon: 'pi pi-trash', severity: 'danger', tooltip: (row) => 'Delete proposal for ' + row.name,
        visible: (row) => row.status === 'pending', disabled: () => this.ui.busy(), handler: (row) => this.moderate(row, 'delete') },
    ],
  }));
  readonly template = signal<TemplatePreview | null>(null);
  readonly grid = computed((): GridData<Category, Category> => {
    const columns = sortableColumns([
      { field: 'label', header: 'Category' }, { field: 'kind', header: 'Type' }, { field: 'status', header: 'Status' },
    ]);
    const present = (row: Category) => ({
      ...row, label: [row.icon, row.name].filter(Boolean).join(' '), status: row.archived ? 'Archived' : 'Active',
    });
    const actions: GridAction<Category>[] = [
      { id: 'edit', icon: 'pi pi-pencil', tooltip: (row) => 'Edit ' + row.name, handler: (row) => this.edit(row) },
      { id: 'archive', icon: 'pi pi-box', tooltip: (row) => (row.archived ? 'Restore ' : 'Archive ') + row.name,
        handler: (row) => this.archive(row) },
      { id: 'delete', icon: 'pi pi-trash', severity: 'danger', tooltip: (row) => 'Delete ' + row.name,
        visible: (row) => !this.children(row.id).length, handler: (row) => this.remove(row) },
    ];
    return {
      columns, rows: this.roots().map(present), actions,
      details: { columns, rows: (row) => this.children(row.id).map(present), actions },
    };
  });
  editorVisible = false;
  groupEditor = false;
  draft = newCategory();
  reset() { this.groupEditor = false; this.draft = newCategory(); this.showEditor(); }
  constructor() {
    void this.ui.load(async () => {
      const [list, moderation] = await Promise.all([this.ui.api.categories(), this.ui.api.importModeration()]);
      this.list.set(list);
      this.moderation.set(moderation);
      this.showModeration.set(!!moderation);
    });
  }
  roots() { return this.list().filter((entry) => !entry.parentId); }
  children(id: string) { return this.list().filter((entry) => entry.parentId === id); }
  parents() { return this.roots().filter((entry) => entry.kind === this.draft.kind && entry.id !== this.draft.id && !entry.archived); }
  edit(category: Category) { this.groupEditor = !category.parentId; this.draft = { ...category }; this.showEditor(); }
  private showEditor() { this.editorVisible = true; }
  save() { return this.ui.run(async () => { this.list.set(await this.ui.api.saveCategory(this.draft)); this.editorVisible = false; }, 'Category saved.'); }
  restore() { return this.ui.run(async () => this.list.set(await this.ui.api.restoreDefaults()), 'Missing household defaults restored where possible.'); }
  moderate(row: CategoryProposal, action: 'edit' | 'accept' | 'delete') {
    const current = this.moderation();
    if (!current) return;
    return this.ui.run(async () => {
      const edit = action === 'edit' ? { name: row.name, group: row.group } : undefined;
      this.moderation.set(await this.ui.api.moderateImportCategory({ token: current.token, version: current.version,
        proposalId: row.id, action, edit }));
      if (action === 'accept') this.list.set(await this.ui.api.categories());
      if (action === 'edit') this.proposalDraft.set(null);
    });
  }
  archive(category: Category) {
    return this.ui.run(async () => {
      this.list.set(await this.ui.api.saveCategory({ ...category, archived: !category.archived }));
    }, category.archived ? 'Category restored.' : 'Category archived.');
  }
  remove(category: Category) {
    return this.ui.run(async () => {
      const { ruleIds } = await this.ui.api.previewCategoryDeletion({ id: category.id });
      const linkedRules = ruleIds.length ? ' This also deletes ' + ruleIds.length + (ruleIds.length === 1 ? ' linked rule.' : ' linked rules.') : '';
      this.ui.confirm('Delete ' + category.name + '?' + linkedRules, () => {
        void this.ui.run(async () => this.list.set(await this.ui.api.deleteCategory({ id: category.id, expectedRuleIds: ruleIds })), 'Category deleted.');
      }, 'danger');
    });
  }
  export() { return this.ui.run(async () => { if (await this.ui.api.exportTemplate()) this.ui.info.set('Template exported.'); }); }
  previewTemplate() { return this.ui.run(async () => this.template.set(await this.ui.api.previewTemplate())); }
  commitTemplate(id: string) {
    return this.ui.run(async () => {
      await this.ui.api.commitTemplate({ id });
      this.template.set(null);
      this.list.set(await this.ui.api.categories());
    }, 'Template imported.');
  }
}
