import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ui } from '../../shared/ui/state';
import type { TemplatePreview } from './portable';
import type { Category } from './contract';

type Draft = Omit<Category, 'id' | 'templateKey' | 'leaf'> & { id?: string };
const newCategory = (): Draft => ({ name: '', kind: 'expense', parentId: null, colour: '#278473', icon: '', sort: 0, archived: false, excludeReports: false });

@Component({
  selector: 'icash-categories',
  imports: [FormsModule],
  template: `
    <div class="page-heading"><div><h1>Categories</h1><p>Organize the income and spending that matter to your household.</p></div>
      <button (click)="draft = blank()">New category</button></div>
    <div class="split-grid">
      <section class="panel stack">
        <h2>Category structure</h2>
        @if (!list().length) { <p class="empty">Create a category or restore the household defaults.</p> }
        @for (group of roots(); track group.id) {
          <div class="category-group">
            <div class="list-row"><span><i class="swatch" [style.background]="group.colour"></i><strong>{{ group.icon }} {{ group.name }}</strong>
              <small class="muted"> · {{ group.kind }}{{ group.archived ? ' · archived' : '' }}</small></span><button (click)="edit(group)">Edit</button></div>
            @for (child of children(group.id); track child.id) {
              <div class="list-row child"><span><i class="swatch" [style.background]="child.colour"></i>{{ child.icon }} {{ child.name }}{{ child.archived ? ' · archived' : '' }}</span>
                <button (click)="edit(child)">Edit</button></div>
            }
          </div>
        }
      </section>
      <div class="stack">
        <form class="panel stack" (ngSubmit)="save()">
          <h2>{{ draft.id ? 'Edit category' : 'New category' }}</h2>
          <label>Category name <input name="name" [(ngModel)]="draft.name" maxlength="80" required></label>
          <div class="field-grid">
            <label>Type <select name="kind" [(ngModel)]="draft.kind"><option value="expense">Expense</option><option value="income">Income</option><option value="transfer">Transfer</option><option value="savings">Savings</option></select></label>
            <label>Parent <select name="parent" [(ngModel)]="draft.parentId"><option [ngValue]="null">Top level</option>
              @for (group of parents(); track group.id) { <option [ngValue]="group.id">{{ group.name }}</option> }
            </select></label>
            <label>Colour <input name="colour" type="color" [(ngModel)]="draft.colour"></label>
            <label>Icon <input name="icon" [(ngModel)]="draft.icon" maxlength="24" placeholder="Optional symbol"></label>
            <label>Display order <input name="sort" type="number" [(ngModel)]="draft.sort"></label>
          </div>
          <label class="check"><input name="excluded" type="checkbox" [(ngModel)]="draft.excludeReports"> Exclude from spending reports</label>
          @if (draft.id) { <label class="check"><input name="archived" type="checkbox" [(ngModel)]="draft.archived"> Archive category</label> }
          <div class="actions"><button class="primary" type="submit" [disabled]="ui.busy() || !draft.name.trim()">Save category</button>
            @if (draft.id) { <button type="button" (click)="draft = blank()">Cancel</button> }
          </div>
        </form>
        <section class="panel stack">
          <h2>Merge categories</h2>
          <label>Source category <select [(ngModel)]="from" (ngModelChange)="usage.set(null)"><option value="">Select source</option>
            @for (item of leaves(); track item.id) { <option [value]="item.id">{{ label(item) }}</option> }
          </select></label>
          <label>Destination category <select [(ngModel)]="to" (ngModelChange)="usage.set(null)"><option value="">Select destination</option>
            @for (item of leaves(); track item.id) { <option [value]="item.id">{{ label(item) }}</option> }
          </select></label>
          <button [disabled]="!from || !to || from === to || ui.busy()" (click)="previewMerge()">Preview merge</button>
          @if (usage(); as counts) {
            <p>{{ counts['transactions'] }} transactions, {{ counts['splits'] }} split lines, {{ counts['rules'] }} rules, and {{ (counts['allocations'] || 0) + (counts['defaults'] || 0) }} budget entries will move. The source is archived.</p>
            <button class="danger" [disabled]="ui.busy()" (click)="merge()">Confirm merge</button>
          }
        </section>
        <section class="panel stack">
          <h2>Templates</h2>
          <div class="actions"><button [disabled]="ui.busy()" (click)="restore()">Restore missing defaults</button>
            <button [disabled]="ui.busy()" (click)="export()">Export template</button>
            <button [disabled]="ui.busy()" (click)="previewTemplate()">Choose template</button></div>
          @if (template(); as data) {
            <p>{{ data.categories }} categories and {{ data.rules }} rules ready to add.</p>
            @for (conflict of data.conflicts; track $index) { <p class="muted">{{ conflict }}</p> }
            <button class="primary" [disabled]="ui.busy()" (click)="commitTemplate(data.token)">Import template</button>
          }
        </section>
      </div>
    </div>
  `,
})
export class CategoriesPage {
  readonly ui = inject(Ui);
  readonly list = signal<Category[]>([]);
  readonly usage = signal<Record<string, number> | null>(null);
  readonly template = signal<TemplatePreview | null>(null);
  draft = newCategory();
  from = '';
  to = '';
  blank = newCategory;
  constructor() { void this.ui.load(async () => this.list.set(await this.ui.api.categories())); }
  roots() { return this.list().filter((entry) => !entry.parentId); }
  children(id: string) { return this.list().filter((entry) => entry.parentId === id); }
  parents() { return this.roots().filter((entry) => entry.kind === this.draft.kind && entry.id !== this.draft.id && !entry.archived); }
  leaves() { return this.list().filter((entry) => entry.leaf && !entry.archived); }
  label(category: Category) {
    const parent = this.list().find((item) => item.id === category.parentId);
    return parent ? parent.name + ' / ' + category.name : category.name;
  }
  edit(category: Category) { this.draft = { ...category }; }
  save() { return this.ui.run(async () => { this.list.set(await this.ui.api.saveCategory(this.draft)); this.draft = newCategory(); }, 'Category saved.'); }
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
