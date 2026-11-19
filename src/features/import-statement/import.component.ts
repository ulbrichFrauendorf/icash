import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, ICheckbox, IDialog, IFileUpload, type FileUploadOptions, IInputText, IMessage, ISelect, ITable, PageHeaderContentDirective, PageLayoutComponent, type GridData } from 'invensys-ng';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Account } from '../accounts/contract';
import { ZarPipe } from '../../shared/ui/pipes';
import { Ui } from '../../shared/ui/state';
import { currencyColumn, sortableColumns, tableMoney } from '../../shared/ui/table-columns';
import { statementLimit, type AuditRow, type Batch, type FilePreview, type ImportPreview, type ImportReview, type ImportReviewRow, type Mapping } from './contract';
import type { Category } from '../categories/contract';
import type { CategoryChoice } from '../openai/contract';
import { reviewCategoryChoices } from '../../shared/ui/category-choices';

type Column = 'date' | 'description' | 'amount' | 'debit' | 'credit' | 'balance' | 'reference';

@Component({
  selector: 'icash-import',
  imports: [FormsModule, ZarPipe, IButton, IInputText, ISelect, ICheckbox, IDialog, IFileUpload, ICard, IMessage, ITable, PageLayoutComponent, PageHeaderContentDirective],
  templateUrl: './import.component.html',
})
export class ImportPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly accounts = signal<Account[]>([]);
  readonly batches = signal<Batch[]>([]);
  readonly audit = signal<AuditRow[]>([]);
  account = '';
  auditBatch: Batch | null = null;
  file: FilePreview | null = null;
  preview: ImportPreview | null = null;
  validating = false;
  files: File[] = [];
  readonly uploadOptions: FileUploadOptions = { multiple: false, maxFiles: 1, fileTypes: ['.csv', '.txt'],
    maxFileSize: statementLimit, maxTotalSize: statementLimit };
  readonly review = signal<ImportReview | null>(null);
  readonly reviewRow = signal<ImportReviewRow | null>(null);
  private categories: Category[] = [];
  private readonly choices = signal(new Map<number, CategoryChoice>());
  delimiter: Mapping['delimiter'] = ',';
  encoding: Mapping['encoding'] = 'utf-8';
  header = 1;
  layout = 'signed';
  columns: Partial<Record<Column, number>> = {};
  dateFormat: Mapping['dateFormat'] | '' = '';
  decimal: Mapping['decimal'] | '' = '';
  invert = false;
  labels: Record<Column, string> = { date: 'Posting date', description: 'Description', amount: 'Amount', debit: 'Debit', credit: 'Credit', balance: 'Balance', reference: 'Reference' };
  constructor() {
    void this.ui.load(async () => {
      const [accounts, batches] = await Promise.all([this.ui.api.accounts(), this.ui.api.batches()]);
      this.accounts.set(accounts.filter((a) => !a.archived));
      this.batches.set(batches);
      if (this.accounts().length === 1) this.account = this.accounts()[0]!.id;
    });
  }
  sourceGrid(file: FilePreview): GridData {
    const width = Math.max(0, ...file.rows.map((row) => row.length));
    return {
      columns: sortableColumns(Array.from({ length: width }, (_, index) => ({ field: 'column' + index, header: 'Column ' + (index + 1) }))),
      rows: file.rows.map((cells, row) => ({ row, ...Object.fromEntries(cells.map((cell, index) => ['column' + index, cell])) })),
    };
  }

  checksGrid(preview: ImportPreview): GridData {
    return {
      columns: sortableColumns([
        { field: 'row', header: 'Row', type: 'number' }, { field: 'values', header: 'Original values' }, { field: 'date', header: 'Posting date' },
        currencyColumn('amount', 'Amount'), { field: 'result', header: 'Result' },
      ]),
      rows: preview.rows.map((row) => ({ row: row.row, values: row.original.join(' · '), date: row.candidate?.date,
        amount: tableMoney(row.candidate?.amount), result: row.message || row.state })),
    };
  }

  readonly auditGrid = computed((): GridData => ({
    columns: sortableColumns([
      { field: 'row', header: 'Row', type: 'number' }, { field: 'state', header: 'State' },
      { field: 'message', header: 'Details' }, { field: 'values', header: 'Original values' },
    ]),
    rows: this.audit().map((row) => ({ ...row, values: row.original.join(' · ') })),
  }));
  readonly batchGrid = computed((): GridData<Batch> => ({
    columns: sortableColumns([
      { field: 'file', header: 'Statement' }, { field: 'account', header: 'Account' }, { field: 'date', header: 'Imported' },
      { field: 'inserted', header: 'Added', type: 'number' }, { field: 'duplicate', header: 'Duplicates', type: 'number' },
      { field: 'rejected', header: 'Rejected', type: 'number' },
    ]),
    rows: this.batches().map((row) => ({ ...row, date: row.createdAt.slice(0, 10) })),
    actions: [{ id: 'audit', icon: 'pi pi-list', tooltip: (row) => 'View rows for ' + row.file, handler: (row) => this.showAudit(row) }],
  }));
  readonly reviewGrid = computed((): GridData<ImportReviewRow> => {
    const byId = new Map(this.categories.map((category) => [category.id, category.name]));
    return {
      columns: sortableColumns([
        { field: 'row', header: 'Row', type: 'number' }, { field: 'description', header: 'Description' },
        { field: 'date', header: 'Posting date' }, currencyColumn('amountValue', 'Amount'), { field: 'category', header: 'Category' },
      ]),
      rows: (this.review()?.rows ?? []).map((row) => {
        const choice = this.categorySelection(row);
        const category = choice === 'suggested' ? row.suggestion?.label : byId.get(choice);
        return { ...row, category: category ?? 'Uncategorized', amountValue: tableMoney(row.amount) };
      }),
      actions: [{ id: 'category', icon: 'pi pi-pencil', tooltip: (row) => 'Change category for row ' + row.row,
        handler: (row) => this.reviewRow.set(row) }],
    };
  });
  fields(): Column[] { return ['date', 'description', ...(this.layout === 'signed' ? ['amount'] as const : ['debit', 'credit'] as const), 'balance', 'reference']; }
  headers() { return this.file?.headers ?? []; }
  invalidate() { this.preview = null; this.closeReview(); this.choices.set(new Map()); }
  reset() { this.files = []; this.file = null; this.invalidate(); }
  selectFiles(files: File[]) {
    const selected = files[0];
    if (!selected) return this.cancel();
    if (!this.account) return;
    this.reset();
    this.files = files;
    return this.ui.run(async () => {
      const file = await this.ui.api.selectImport({ id: this.account, name: selected.name,
        bytes: new Uint8Array(await selected.arrayBuffer()) });
      this.file = file;
      this.invalidate();
      this.delimiter = file.delimiter;
      this.encoding = file.encoding;
      this.header = file.header;
      this.useFileMapping(file);
    });
  }
  cancel() {
    return this.ui.run(async () => {
      if (this.file) await this.ui.api.cancelImport({ id: this.file.token });
      this.reset();
    });
  }
  private useFileMapping(file: FilePreview) {
    const saved = file.saved?.delimiter === file.delimiter && file.saved.header === file.header &&
      file.saved.date === file.suggested.date && file.saved.description === file.suggested.description &&
      file.saved.amount === file.suggested.amount && file.saved.debit === file.suggested.debit &&
      file.saved.credit === file.suggested.credit && file.saved.balance === file.suggested.balance &&
      file.saved.reference === file.suggested.reference ? file.saved : null;
    this.dateFormat = file.suggested.dateFormat ?? saved?.dateFormat ?? '';
    this.decimal = file.suggested.decimal ?? saved?.decimal ?? '';
    this.invert = saved?.invert ?? false;
    this.useSuggestions(saved ?? file.suggested);
  }

  private useSuggestions(suggestion: Partial<Mapping>) {
    this.columns = Object.fromEntries(Object.keys(this.labels).map((key) => [key, suggestion[key as Column]]));
    this.layout = suggestion.amount === undefined && suggestion.debit !== undefined ? 'separate' : 'signed';
  }
  decode() {
    return this.ui.run(async () => {
      if (!this.file) return;
      this.file = await this.ui.api.decodeImport({ token: this.file.token, delimiter: this.delimiter, encoding: this.encoding, header: this.header });
      this.useFileMapping(this.file);
      this.invalidate();
    });
  }
  validate() {
    return this.ui.run(async () => {
      if (!this.file || !this.dateFormat || !this.decimal) return;
      if (this.header !== this.file.header || this.delimiter !== this.file.delimiter || this.encoding !== this.file.encoding) {
        throw new Error('Read the columns again after changing the file format.');
      }
      const { date, description, balance, reference, amount, debit, credit } = this.columns;
      if (date === undefined || description === undefined) throw new Error('Map the posting date and description first.');
      this.invalidate();
      this.validating = true;
      try {
        this.preview = await this.ui.api.previewImport({ token: this.file.token, mapping: {
          date, description, balance, reference, ...(this.layout === 'signed' ? { amount } : { debit, credit }),
          delimiter: this.delimiter, encoding: this.encoding, header: this.header, dateFormat: this.dateFormat,
          decimal: this.decimal, invert: this.invert,
        } });
        if (this.preview.review) {
          this.categories = await this.ui.api.categories();
          this.openReview();
        }
      } finally { this.validating = false; }
    });
  }
  categoryOptions(row: ImportReviewRow) {
    return reviewCategoryChoices(this.categories, row.treatment, 'Leave uncategorized', row.suggestion);
  }
  categorySelection(row: ImportReviewRow) {
    return this.choices().get(row.row) ?? (row.suggestion ? 'suggested' : '');
  }
  chooseCategory(row: number, choice: CategoryChoice) {
    this.choices.update((choices) => new Map(choices).set(row, choice));
  }
  openReview() { this.review.set(this.preview?.review ?? null); }
  closeReview() { this.review.set(null); this.reviewRow.set(null); }
  errors() { return this.ui.run(async () => { if (this.file) await this.ui.api.exportErrors({ id: this.file.token }); }); }
  commit(saveRules = false) {
    return this.ui.run(async () => {
      if (!this.file || !this.preview) return;
      const result = await this.ui.api.commitImport({ token: this.file.token, version: this.preview.version,
        acceptRejected: this.preview.counts.rejected > 0,
        review: this.preview.review ? { saveRules, changes: [...this.choices()].map(([row, choice]) => ({ row, choice })) } : undefined });
      this.reset();
      this.batches.set(await this.ui.api.batches());
      this.ui.info.set(`Import complete. ${result.inserted} added, ${result.duplicate} duplicates, ${result.rejected} rejected.` + (result.rulesSaved ? ` Saved ${result.rulesSaved} rules.` : ''));
    });
  }
  showAudit(batch: Batch) {
    return this.ui.run(async () => {
      this.audit.set(await this.ui.api.audit({ id: batch.id }));
      this.auditBatch = batch;
    });
  }
}
