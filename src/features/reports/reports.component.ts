import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IAccordion, IButton, ICard, IInputText, IProgressSpinner, ISelect, ITable, PageHeaderActionsDirective, PageRightSidebarDirective, PageLayoutComponent, type GridData, NoContentComponent } from 'invensys-ng';
import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { formatZar, ZarPipe } from '../../shared/ui/pipes';
import { Ui } from '../../shared/ui/state';
import { currencyColumn, sortableColumns, tableMoney } from '../../shared/ui/table-columns';
import type { Account } from '../accounts/contract';
import type { Report } from './contract';

import { ReportChart } from './chart.component';

@Component({
  selector: 'icash-reports',
  imports: [FormsModule, ZarPipe, ReportChart, IButton, IInputText, ISelect, ICard, IAccordion, IProgressSpinner, ITable, NoContentComponent, PageLayoutComponent, PageHeaderActionsDirective, PageRightSidebarDirective],
  templateUrl: './reports.component.html',
})
export class ReportsPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly detailed = input(false);
  readonly data = signal<Report | null>(null);
  readonly accounts = signal<Account[]>([]);
  month = this.ui.month();
  period: 'month' | 'year' = 'month';
  account = '';
  range = 6;
  readonly budgetLabels = ['Allocated', 'Actual'];
  private chartCache = new WeakMap<Report, Map<string, { labels: string[]; series: { label: string; values: number[]; colour: string }[] }>>();

  constructor() {
    void this.ui.load(async () => {
      const [accounts, report] = await Promise.all([this.ui.api.accounts(), this.ui.api.report(this.options())]);
      this.accounts.set(accounts); this.data.set(report);
    });
  }
  private options() { return { month: this.month, accountId: this.account || undefined, period: this.period }; }
  changeMonth(month: string) { if (month) { this.month = month; this.ui.month.set(month); return this.refresh(); } }
  refresh() { return this.ui.run(async () => this.data.set(await this.ui.api.report(this.options()))); }
  export() { return this.ui.run(async () => { if (await this.ui.api.exportReport(this.options())) this.ui.info.set('Report exported.'); }); }
  drill(report: Report, id: string | null) {
    this.ui.go('Transactions', { start: report.start, end: report.end, accountId: this.account || undefined, categoryId: id, type: 'expense', scoped: 'report' });
  }
  trendGrid(report: Report, range: number): GridData {
    return {
      columns: sortableColumns([
        { field: 'month', header: 'Month' }, currencyColumn('incomeValue', 'Income'),
        currencyColumn('expenseValue', 'Spending'), currencyColumn('netValue', 'Cash flow'),
      ]),
      rows: report.trend.slice(-range).map((row) => ({ ...row, incomeValue: tableMoney(row.income),
        expenseValue: tableMoney(row.expense), netValue: tableMoney(row.net) })),
    };
  }
  categoryGrid(report: Report): GridData {
    return {
      columns: sortableColumns([
        { field: 'name', header: 'Category group' }, currencyColumn('spending', 'Spending'),
        { field: 'baselineLabel', header: 'Spending patterns' },
      ]),
      rows: report.categories.map((row) => ({ ...row, spending: tableMoney(row.amount),
        baselineLabel: row.unusual ? 'Above median ' + formatZar(row.baseline) + ' across ' + row.historyMonths + ' prior periods with activity' : '—' })),
      actions: [{ id: 'contributors', icon: 'pi pi-list', tooltip: (row) => 'Review spending for ' + row.name,
        handler: (row) => this.drill(report, row.id) }],
    };
  }
  goalGrid(report: Report): GridData {
    return {
      columns: sortableColumns([
        { field: 'name', header: 'Goal' }, currencyColumn('saved', 'Saved'), currencyColumn('targetValue', 'Target'),
        { field: 'percent', header: 'Progress (%)', type: 'number', align: 'right' },
      ]),
      rows: report.goals.map((row) => ({ ...row, saved: tableMoney(row.progress), targetValue: tableMoney(row.target),
        percent: Math.round(row.progress / row.target * 100) })),
    };
  }
  private cached(report: Report, key: string, build: () => { labels: string[]; series: { label: string; values: number[]; colour: string }[] }) {
    let options = this.chartCache.get(report);
    if (!options) { options = new Map(); this.chartCache.set(report, options); }
    let chart = options.get(key);
    if (!chart) { chart = build(); options.set(key, chart); }
    return chart;
  }
  private trendChart(report: Report, range: number) {
    return this.cached(report, 'trend' + range, () => {
      const rows = report.trend.slice(-range);
      return { labels: rows.map((row) => row.month), series: [
        { label: 'Income', values: rows.map((row) => row.income), colour: '--icash-income' },
        { label: 'Spending', values: rows.map((row) => row.expense), colour: '--icash-spending' },
      ] };
    });
  }
  trendLabels(report: Report, range: number) { return this.trendChart(report, range).labels; }
  trendSeries(report: Report, range: number) { return this.trendChart(report, range).series; }
  private categoryChart(report: Report) {
    return this.cached(report, 'categories', () => ({
      labels: report.categories.slice(0, 6).map((row) => row.name),
      series: [{ label: 'Net spending', values: report.categories.slice(0, 6).map((row) => row.amount), colour: '--icash-spending' }],
    }));
  }
  categoryLabels(report: Report) { return this.categoryChart(report).labels; }
  categorySeries(report: Report) { return this.categoryChart(report).series; }
  budgetSeries(report: Report) { return this.cached(report, 'budget', () => ({
    labels: this.budgetLabels, series: [{ label: 'Household budget', values: [report.allocated, report.budgetActual], colour: '--icash-income' }],
  })).series; }
}
