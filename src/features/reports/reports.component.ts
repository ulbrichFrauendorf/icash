import { rowChoices, retainChoice } from '../../shared/ui/choices';
import { IAccordion, IButton, ICalendar, ICard, IChart, type IChartData, IProgressSpinner, ISelect, ITable, PageHeaderActionsDirective, PageRightSidebarDirective, PageLayoutComponent, type GridData, NoContentComponent } from 'invensys-ng';
import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { localDate } from '../../shared/finance';
import { formatZar, ZarPipe } from '../../shared/ui/pipes';
import { Ui } from '../../shared/ui/state';
import { currencyColumn, sortableColumns, tableMoney } from '../../shared/ui/table-columns';
import type { Account } from '../accounts/contract';
import type { Report } from './contract';

@Component({
  selector: 'icash-reports',
  imports: [FormsModule, ZarPipe, IButton, ICalendar, ISelect, ICard, IChart, IAccordion, IProgressSpinner, ITable, NoContentComponent, PageLayoutComponent, PageHeaderActionsDirective, PageRightSidebarDirective],
  templateUrl: './reports.component.html',
})
export class ReportsPage {
  readonly rowChoices = rowChoices;
  readonly selected = retainChoice();
  readonly ui = inject(Ui);
  readonly detailed = input(false);
  readonly data = signal<Report | null>(null);
  readonly accounts = signal<Account[]>([]);
  selectedMonth = new Date(this.ui.month() + '-01T12:00:00');
  get month() { return localDate(this.selectedMonth).slice(0, 7); }
  period: 'month' | 'year' = 'month';
  account = '';
  range = 6;
  private chartCache = new WeakMap<Report, Map<string, IChartData[]>>();

  constructor() {
    void this.ui.load(async () => {
      const [accounts, report] = await Promise.all([this.ui.api.accounts(), this.ui.api.report(this.options())]);
      this.accounts.set(accounts); this.data.set(report);
    });
  }
  private options() { return { month: this.month, accountId: this.account || undefined, period: this.period }; }
  changeMonth(date: Date | null) {
    if (!date) return;
    this.selectedMonth = date;
    this.ui.month.set(this.month);
    return this.refresh();
  }
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
  private cached(report: Report, key: string, build: () => IChartData) {
    let options = this.chartCache.get(report);
    if (!options) { options = new Map(); this.chartCache.set(report, options); }
    let charts = options.get(key);
    if (!charts) { charts = [build()]; options.set(key, charts); }
    return charts;
  }
  trendChart(report: Report, range: number) {
    return this.cached(report, 'trend' + range, () => {
      const rows = report.trend.slice(-range);
      return { chartType: 'bar', labels: rows.map((row) => row.month), dataSets: [
        { label: 'Income', data: rows.map((row) => row.income / 100), backgroundColors: ['--icash-income'] },
        { label: 'Spending', data: rows.map((row) => row.expense / 100), backgroundColors: ['--icash-spending'] },
      ] };
    });
  }
  categoryChart(report: Report) {
    return this.cached(report, 'categories', () => {
      const rows = report.categories.slice(0, 6);
      return {
        chartType: 'bar-horizontal', labels: rows.map((row) => row.name),
        dataSets: [{ label: 'Net spending', data: rows.map((row) => row.amount / 100), backgroundColors: ['--icash-spending'] }],
      };
    });
  }
  budgetChart(report: Report) {
    return this.cached(report, 'budget', () => ({
      chartType: 'bar', labels: ['Allocated', 'Actual'],
      dataSets: [{ label: 'Household budget', data: [report.allocated / 100, report.budgetActual / 100], backgroundColors: ['--icash-income'] }],
    }));
  }
}
