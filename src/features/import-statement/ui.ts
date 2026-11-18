import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Account } from '../accounts/contract';
import { ZarPipe } from '../../shared/ui/pipes';
import { Ui } from '../../shared/ui/state';
import type { AuditRow, Batch, FilePreview, ImportPreview, Mapping } from './contract';

type Column = 'date' | 'description' | 'amount' | 'debit' | 'credit' | 'balance' | 'reference';

@Component({
  selector: 'icash-import',
  imports: [FormsModule, ZarPipe],
  template: `
    <div class="page-heading"><div><h1>Import statements</h1><p>Review an Absa CSV before adding it to your ledger.</p></div></div>
    <section class="panel stack">
      <h2>1. Choose a statement</h2>
      <div class="actions">
        <label>Destination account <select [(ngModel)]="account" (ngModelChange)="reset()">
          <option value="">Select account</option>
          @for (a of accounts(); track a.id) { <option [value]="a.id">{{ a.name }}</option> }
        </select></label>
        <button class="primary" [disabled]="!account || ui.busy()" (click)="choose()">Choose CSV</button>
        @if (!accounts().length) { <button (click)="ui.go('Accounts')">Add an account</button> }
      </div>
    </section>
    @if (file; as current) {
      <section class="panel stack">
        <div class="section-header"><h2>2. Map columns</h2><button [disabled]="ui.busy()" (click)="cancel()">Cancel import</button></div>
        <p class="muted">{{ current.fileName }}</p>
        <div class="field-grid">
          <label>Delimiter <select [(ngModel)]="delimiter" (ngModelChange)="invalidate()"><option value=",">Comma</option><option value=";">Semicolon</option><option [value]="'\t'">Tab</option></select></label>
          <label>Encoding <select [(ngModel)]="encoding" (ngModelChange)="invalidate()"><option value="utf-8">UTF-8</option><option value="windows-1252">Windows-1252</option><option value="utf-16le">UTF-16LE</option></select></label>
          <label>Header record <input type="number" min="1" max="50" [(ngModel)]="header" (ngModelChange)="invalidate()"></label>
          <button [disabled]="ui.busy()" (click)="decode()">Read columns</button>
        </div>
        <div class="table-scroll"><table class="compact"><tbody>
          @for (row of current.rows; track $index) { <tr>@for (value of row; track $index) { <td>{{ value }}</td> }</tr> }
        </tbody></table></div>
        <div class="field-grid">
          <label>Amount layout <select [(ngModel)]="layout" (ngModelChange)="invalidate()"><option value="signed">Signed amount</option><option value="separate">Separate debit and credit</option></select></label>
          <label>Date format <select [(ngModel)]="dateFormat" (ngModelChange)="invalidate()"><option value="">Select date format</option><option value="ymd">Year-month-day</option><option value="dmy">Day-month-year</option><option value="mdy">Month-day-year</option></select></label>
          <label>Decimal separator <select [(ngModel)]="decimal" (ngModelChange)="invalidate()"><option value="">Select decimal separator</option><option value=".">Period (123.45)</option><option value=",">Comma (123,45)</option></select></label>
          <label class="check"><input type="checkbox" [(ngModel)]="invert" (ngModelChange)="invalidate()"> Invert amount signs</label>
        </div>
        <div class="field-grid">
          @for (key of fields(); track key) {
            <label>{{ labels[key] }} <select [(ngModel)]="columns[key]" (ngModelChange)="invalidate()">
              <option [ngValue]="undefined">Unmapped</option>
              @for (column of headers(); track $index) { <option [ngValue]="$index">{{ $index + 1 }} · {{ column }}</option> }
            </select></label>
          }
        </div>
        <div><button class="primary" [disabled]="!dateFormat || !decimal || ui.busy()" (click)="validate()">Validate statement</button></div>
      </section>
    }
    @if (preview; as data) {
      <section class="panel stack">
        <h2>3. Review and import</h2>
        <div class="summary">{{ data.counts.accepted }} ready · {{ data.counts.duplicate }} duplicate · {{ data.counts.review }} to review · {{ data.counts.rejected }} rejected</div>
        <p>Preview totals · debits {{ data.debits | zar }} · credits {{ data.credits | zar }} · net {{ data.net | zar }}</p>
        @if (data.reconciliation) { <p class="warning">{{ data.reconciliation }}</p> }
        @if (data.counts.rejected) {
          <div class="actions"><button [disabled]="ui.busy()" (click)="errors()">Export rejected rows</button>
            <label class="check"><input type="checkbox" [(ngModel)]="acceptRejected"> Continue with valid rows</label></div>
        }
        @if (data.review.length) {
          <div class="actions"><button (click)="setReviews('skip')">Skip all possible overlaps</button><button (click)="setReviews('keep')">Keep all after review</button></div>
          <div class="table-scroll review-table"><table><thead><tr><th>Row</th><th>Imported row</th><th>Existing ledger matches</th><th>Decision</th></tr></thead><tbody>
          @for (row of data.review.slice(reviewPage * 50, (reviewPage + 1) * 50); track row.row) {
            <tr><td>{{ row.row }}</td><td>{{ row.candidate?.date }} · {{ row.candidate?.description }} · {{ row.candidate?.amount | zar }}
              <div class="muted">Balance {{ row.candidate?.balance | zar }} · Ref {{ row.candidate?.reference || '—' }}</div></td>
              <td>@for (match of row.matches; track $index) {
                <div>{{ match.date }} · {{ match.description }} · {{ match.amount | zar }}</div>
                <div class="muted">Balance {{ match.balance | zar }} · Ref {{ match.reference || '—' }}</div>
              }</td>
              <td><select [(ngModel)]="decisions[row.row]" [attr.aria-label]="'Decision for row ' + row.row">
                <option [ngValue]="undefined">Choose</option><option value="skip">Skip duplicate</option><option value="keep">Keep transaction</option></select></td></tr>
          }
          </tbody></table></div>
          <div class="actions"><button [disabled]="reviewPage === 0" (click)="reviewPage = reviewPage - 1">Previous overlaps</button>
            <span>Overlap page {{ reviewPage + 1 }}</span>
            <button [disabled]="(reviewPage + 1) * 50 >= data.review.length" (click)="reviewPage = reviewPage + 1">Next overlaps</button></div>
        }
        <div class="table-scroll"><table class="compact"><thead><tr><th>Row</th><th>Original values</th><th>Date</th><th>Amount</th><th>Result</th></tr></thead><tbody>
          @for (row of data.rows; track row.row) { <tr><td>{{ row.row }}</td><td>{{ row.original.join(' · ') }}</td>
            <td>{{ row.candidate?.date }}</td><td>{{ row.candidate?.amount | zar }}</td><td>{{ row.message || row.state }}</td></tr> }
        </tbody></table></div>
        <div class="actions"><button class="primary" [disabled]="ui.busy() || (!!data.counts.rejected && !acceptRejected) || !reviewed()" (click)="commit()">Import reviewed rows</button></div>
      </section>
    }
    <section class="panel stack">
      <h2>Import history</h2>
      @if (!batches().length) { <p class="empty">Statements you import appear here.</p> }
      @for (batch of batches(); track batch.id) {
        <div class="list-row"><div><strong>{{ batch.file }}</strong><div class="muted">{{ batch.account }} · {{ batch.createdAt.slice(0, 10) }} · {{ batch.inserted }} added · {{ batch.duplicate }} duplicates · {{ batch.rejected }} rejected</div></div>
          <button [disabled]="ui.busy()" (click)="showAudit(batch.id)">View rows</button></div>
      }
      @if (auditBatch) {
        <div class="table-scroll"><table class="compact"><thead><tr><th>Row</th><th>State</th><th>Original values</th></tr></thead><tbody>
          @for (row of audit(); track row.row) { <tr><td>{{ row.row }}</td><td>{{ row.message || row.state }}</td><td>{{ row.original.join(' · ') }}</td></tr> }
        </tbody></table></div>
        <div class="actions"><button [disabled]="auditPage === 0 || ui.busy()" (click)="showAudit(auditBatch, auditPage - 1)">Previous audit page</button>
          <button [disabled]="audit().length < 100 || ui.busy()" (click)="showAudit(auditBatch, auditPage + 1)">Next audit page</button></div>
      }
    </section>
  `,
})
export class ImportPage {
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
