import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, ICheckbox, IInputText, ISelect, ITable, PageHeaderContentDirective, PageLayoutComponent, IDialog, type GridAction, type GridData } from 'invensys-ng';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui } from '../../shared/ui/state';
import { sortableColumns } from '../../shared/ui/table-columns';
import type { TemplatePreview } from './portable';
import type { Category } from './contract';

type Draft = Omit<Category, 'id' | 'templateKey' | 'leaf'> & { id?: string };
const newCategory = (): Draft => ({ name: '', kind: 'expense', parentId: null, colour: '#278473', icon: '', sort: 0, archived: false, excludeReports: false });

@Component({
  selector: 'icash-categories',
  imports: [FormsModule, IButton, IInputText, ISelect, ICheckbox, ICard, ITable, PageLayoutComponent, PageHeaderContentDirective, IDialog],
  templateUrl: './categories.component.html',
})
export class CategoriesPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly list = signal<Category[]>([]);
  readonly usage = signal<Record<string, number> | null>(null);
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
    ];
    return {
      columns, rows: this.roots().map(present), actions,
      details: { columns, rows: (row) => this.children(row.id).map(present), actions },
    };
  });
  editorVisible = false;
  groupEditor = false;
  draft = newCategory();
  from = '';
  to = '';
  reset() { this.groupEditor = false; this.draft = newCategory(); this.showEditor(); }
  constructor() { void this.ui.load(async () => this.list.set(await this.ui.api.categories())); }
  roots() { return this.list().filter((entry) => !entry.parentId); }
  children(id: string) { return this.list().filter((entry) => entry.parentId === id); }
  parents() { return this.roots().filter((entry) => entry.kind === this.draft.kind && entry.id !== this.draft.id && !entry.archived); }
  leaves() { return this.list().filter((entry) => entry.leaf && !entry.archived); }
  readonly categoryLabel = (category: Category) => this.label(category);
  label(category: Category) {
    const parent = this.list().find((item) => item.id === category.parentId);
    return parent ? parent.name + ' / ' + category.name : category.name;
  }
  edit(category: Category) { this.groupEditor = !category.parentId; this.draft = { ...category }; this.showEditor(); }
  private showEditor() { this.editorVisible = true; }
  save() { return this.ui.run(async () => { this.list.set(await this.ui.api.saveCategory(this.draft)); this.editorVisible = false; }, 'Category saved.'); }
  restore() { return this.ui.run(async () => this.list.set(await this.ui.api.restoreDefaults()), 'Missing household defaults restored where possible.'); }
  previewMerge() { return this.ui.run(async () => this.usage.set(await this.ui.api.categoryUsage({ id: this.from }))); }
  merge() {
    return this.ui.run(async () => {
      this.list.set(await this.ui.api.mergeCategories({ from: this.from, to: this.to }));
      this.usage.set(null);
      this.from = ''; this.to = '';
    }, 'Categories merged.');
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
