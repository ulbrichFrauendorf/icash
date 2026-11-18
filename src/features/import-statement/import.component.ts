import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IButton, ICard, ICheckbox, IInputText, IMessage, ISelect, ITable, type GridData, NoContentComponent } from 'invensys-ng';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Account } from '../accounts/contract';
import { formatZar, ZarPipe } from '../../shared/ui/pipes';
import { Ui } from '../../shared/ui/state';
import type { AuditRow, Batch, FilePreview, ImportPreview, Mapping } from './contract';

type Column = 'date' | 'description' | 'amount' | 'debit' | 'credit' | 'balance' | 'reference';

@Component({
  selector: 'icash-import',
  imports: [FormsModule, ZarPipe, IButton, IInputText, ISelect, ICheckbox, ICard, IMessage, ITable, NoContentComponent],
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
  auditBatch = '';
  auditPage = 0;
  reviewPage = 0;
  file: FilePreview | null = null;
  preview: ImportPreview | null = null;
  acceptRejected = false;
  decisions: Record<string, 'keep' | 'skip'> = {};
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
      columns: Array.from({ length: width }, (_, index) => ({ field: 'column' + index, header: 'Column ' + (index + 1) })),
      rows: file.rows.map((cells) => Object.fromEntries(cells.map((cell, index) => ['column' + index, cell]))),
    };
  }

  checksGrid(preview: ImportPreview): GridData {
    return {
      columns: [
        { field: 'row', header: 'Row' }, { field: 'values', header: 'Original values' }, { field: 'date', header: 'Posting date' },
        { field: 'amount', header: 'Amount', align: 'right' }, { field: 'result', header: 'Result' },
      ],
      rows: preview.rows.map((row) => ({ row: row.row, values: row.original.join(' · '), date: row.candidate?.date,
        amount: formatZar(row.candidate?.amount), result: row.message || row.state })),
    };
  }

  readonly auditGrid = computed((): GridData => ({
    columns: [
      { field: 'row', header: 'Row' }, { field: 'state', header: 'State' },
      { field: 'message', header: 'Details' }, { field: 'values', header: 'Original values' },
    ],
    rows: this.audit().map((row) => ({ ...row, values: row.original.join(' · ') })),
  }));
  readonly overlapChoices = [
    { value: undefined, label: 'Choose' }, { value: 'skip', label: 'Skip duplicate' }, { value: 'keep', label: 'Keep transaction' },
  ];
  fields(): Column[] { return ['date', 'description', ...(this.layout === 'signed' ? ['amount'] as const : ['debit', 'credit'] as const), 'balance', 'reference']; }
  headers() { return this.file?.rows[Math.min(this.file.header - 1, 3)] ?? []; }
  invalidate() { this.preview = null; this.acceptRejected = false; this.decisions = {}; this.reviewPage = 0; }
  reset() { this.file = null; this.invalidate(); }
  choose() {
    return this.ui.run(async () => {
      const file = await this.ui.api.selectImport({ id: this.account });
      if (!file) return;
      this.file = file;
      this.invalidate();
      this.delimiter = file.delimiter;
      this.encoding = file.encoding;
      this.header = file.header;
      const saved = file.saved?.delimiter === file.delimiter && file.saved.header === file.header &&
        file.saved.date === file.suggested.date && file.saved.description === file.suggested.description &&
        file.saved.amount === file.suggested.amount && file.saved.debit === file.suggested.debit && file.saved.credit === file.suggested.credit ? file.saved : null;
      this.dateFormat = saved?.dateFormat ?? '';
      this.decimal = saved?.decimal ?? '';
      this.invert = saved?.invert ?? false;
      this.useSuggestions(saved ?? file.suggested);
    });
  }
  cancel() {
    return this.ui.run(async () => {
      if (this.file) await this.ui.api.cancelImport({ id: this.file.token });
      this.reset();
    });
  }
  useSuggestions(suggestion: Partial<Mapping>) {
    this.columns = Object.fromEntries(Object.keys(this.labels).map((key) => [key, suggestion[key as Column]]));
    this.layout = suggestion.amount === undefined && suggestion.debit !== undefined ? 'separate' : 'signed';
  }
  decode() {
    return this.ui.run(async () => {
      if (!this.file) return;
      this.file = await this.ui.api.decodeImport({ token: this.file.token, delimiter: this.delimiter, encoding: this.encoding, header: this.header });
      this.useSuggestions(this.file.suggested);
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
      this.preview = await this.ui.api.previewImport({ token: this.file.token, mapping: {
        date, description, balance, reference, ...(this.layout === 'signed' ? { amount } : { debit, credit }),
        delimiter: this.delimiter, encoding: this.encoding, header: this.header, dateFormat: this.dateFormat,
        decimal: this.decimal, invert: this.invert,
      } });
    });
  }
  reviewed() { return this.preview?.review.every((row) => Boolean(this.decisions[row.row])) ?? false; }
  setReviews(value: 'skip' | 'keep') { for (const row of this.preview?.review ?? []) this.decisions[row.row] = value; }
  errors() { return this.ui.run(async () => { if (this.file) await this.ui.api.exportErrors({ id: this.file.token }); }); }
  commit() {
    return this.ui.run(async () => {
      if (!this.file || !this.preview) return;
      const result = await this.ui.api.commitImport({ token: this.file.token, version: this.preview.version,
        acceptRejected: this.acceptRejected, decisions: this.decisions });
      this.reset();
      this.batches.set(await this.ui.api.batches());
      this.ui.info.set(`Import complete. ${result.inserted} added, ${result.duplicate} duplicates, ${result.rejected} rejected.`);
    });
  }
  showAudit(id: string, page = 0) {
    return this.ui.run(async () => {
      this.audit.set(await this.ui.api.audit({ id, page }));
      this.auditBatch = id;
      this.auditPage = page;
    });
  }
}
