import { AfterViewInit, Component, ElementRef, inject, input, OnChanges, OnDestroy, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { BarController, BarElement, CategoryScale, Chart, Legend, LinearScale, Tooltip } from 'chart.js';
import { ZarPipe } from '../../shared/ui/pipes';
import { Ui } from '../../shared/ui/state';
import type { Account } from '../accounts/contract';
import type { Report } from './contract';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Legend, Tooltip);

@Component({
  selector: 'icash-chart',
  template: '<div class="chart"><canvas #canvas role="img" [attr.aria-label]="label()"></canvas></div>',
})
export class ReportChart implements AfterViewInit, OnChanges, OnDestroy {
  readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly label = input.required<string>();
  readonly labels = input.required<string[]>();
  readonly series = input.required<{ label: string; values: number[]; colour: string }[]>();
  private chart?: Chart;
  private ready = false;
  ngAfterViewInit() { this.ready = true; this.draw(); }
  ngOnChanges() { this.draw(); }
  ngOnDestroy() { this.chart?.destroy(); }
  private draw() {
    if (!this.ready) return;
    this.chart?.destroy();
    const canvas = this.canvas().nativeElement;
    const colours = getComputedStyle(canvas);
    const text = colours.getPropertyValue('--muted').trim();
    const border = colours.getPropertyValue('--line').trim();
    this.chart = new Chart(canvas, {
      type: 'bar',
      data: { labels: this.labels(), datasets: this.series().map((item) => ({
        label: item.label, data: item.values.map((value) => value / 100), backgroundColor: item.colour, borderRadius: 4,
      })) },
      options: { maintainAspectRatio: false, animation: false, color: text,
        scales: { x: { ticks: { color: text }, grid: { display: false } }, y: { ticks: { color: text }, grid: { color: border } } },
        plugins: { legend: { display: this.series().length > 1 }, tooltip: { callbacks: {
          label: (context) => context.dataset.label + ' · ' + new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(context.parsed.y ?? 0),
        } } },
      },
    });
  }
}

@Component({
  selector: 'icash-reports',
  imports: [FormsModule, ZarPipe, ReportChart, MatProgressSpinner],
  template: `
    <div class="page-heading">
      <div><h1>{{ detailed() ? 'Financial reports' : 'Household overview' }}</h1><p>{{ detailed() ? 'Review and export your household’s financial performance.' : 'See what came in, what went out, and what’s left to spend.' }}</p></div>
      <button class="primary" (click)="ui.go('Import')">Import statement</button>
    </div>
    <section class="panel actions report-filters">
      <label>Report month <input type="month" [ngModel]="month" (ngModelChange)="changeMonth($event)" [disabled]="ui.busy()"></label>
      <label>Account <select [(ngModel)]="account" (ngModelChange)="refresh()" [disabled]="ui.busy()"><option value="">All accounts</option>
        @for (row of accounts(); track row.id) { <option [value]="row.id">{{ row.name }}</option> }</select></label>
      @if (detailed()) {
        <label>Period <select [(ngModel)]="period" (ngModelChange)="refresh()" [disabled]="ui.busy()"><option value="month">Monthly</option><option value="year">Annual</option></select></label>
        <button [disabled]="ui.busy()" (click)="export()">Export report</button>
      }
    </section>
    @if (data(); as report) {
      <div class="metric-grid">
        <section class="metric"><span>Income</span><strong data-testid="income">{{ report.income | zar }}</strong></section>
        <section class="metric"><span>Net spending</span><strong data-testid="spending">{{ report.expense | zar }}</strong></section>
        <section class="metric"><span>Operating cash flow</span><strong data-testid="cash-flow">{{ report.net | zar }}</strong></section>
        <section class="metric accent"><span>Budget remaining</span><strong data-testid="overview-remaining">{{ report.remaining | zar }}</strong></section>
      </div>
      <div class="section-header period-label"><span>{{ report.start }} to {{ report.end }}</span>
        <span class="badge">{{ report.covered ? 'Statement coverage confirmed' : 'Statement coverage unconfirmed' }}</span></div>
      @if (!accounts().length) {
        <section class="panel empty"><h2>Get started</h2><p>Add an account and import a statement to see your household’s activity.</p><button (click)="ui.go('Accounts')">Set up accounts</button></section>
      }
      <div class="split-grid">
        <section class="panel stack">
          <div class="section-header"><h2>Income and spending</h2><label>Chart range <select [(ngModel)]="range"><option [ngValue]="6">6 months</option><option [ngValue]="12">12 months</option></select></label></div>
          <icash-chart label="Bar chart of monthly income and spending" [labels]="trendLabels(report, range)" [series]="trendSeries(report, range)"/>
          <details><summary>View chart data</summary><div class="table-scroll"><table class="compact">
            <thead><tr><th>Month</th><th>Income</th><th>Spending</th><th>Cash flow</th></tr></thead><tbody>
            @for (row of report.trend.slice(-range); track row.month) { <tr><td>{{ row.month }}</td><td>{{ row.income | zar }}</td><td>{{ row.expense | zar }}</td><td>{{ row.net | zar }}</td></tr> }
            </tbody></table></div></details>
        </section>
        <section class="panel stack">
          <h2>Spending by category</h2>
          @if (report.categories.length) {
            <icash-chart label="Bar chart of top spending categories" [labels]="categoryLabels(report)" [series]="categorySeries(report)"/>
            <div class="table-scroll"><table class="compact"><thead><tr><th>Category</th><th class="number">Spending</th></tr></thead><tbody>
            @for (row of report.categories; track row.id) {
              <tr><td><button class="text-button" (click)="drill(report, row.id)">{{ row.name }}</button>
                @if (row.unusual) { <span class="badge">Higher than usual</span>
                  <div class="muted">Median {{ row.baseline | zar }} across {{ row.historyMonths }} verified months</div> }</td><td class="number">{{ row.amount | zar }}</td></tr>
            }
            </tbody></table></div>
          } @else { <p class="empty">Category spending appears after you import a statement.</p> }
        </section>
        <section class="panel stack">
          <div class="section-header"><h2>Household budget</h2><button (click)="ui.go('Budgets')">Open budgets</button></div>
          @if (account) { <p class="muted">Budget figures cover the whole household.</p> }
          <icash-chart label="Bar chart of household budget and actual spending" [labels]="budgetLabels" [series]="budgetSeries(report)"/>
          <div class="list-row"><span>Allocated</span><strong>{{ report.allocated | zar }}</strong></div>
          <div class="list-row"><span>Actual against budget</span><strong>{{ report.budgetActual | zar }}</strong></div>
        </section>
        <section class="panel stack">
          <h2>Review and plan</h2>
          <div class="list-row"><span>Uncategorized transactions</span><strong>{{ report.uncategorized }}</strong></div>
          <div class="list-row"><button class="text-button" (click)="ui.go('Savings')">Savings progress to date</button><strong data-testid="goal-progress">{{ report.goalProgress | zar }}</strong></div>
          @if (!account) { <div class="list-row"><button class="text-button" (click)="ui.go('Recurring')">Forecast commitments</button><strong>{{ report.commitments | zar }}</strong></div> }
          @if (report.goals.length) {
            <details><summary>Savings goal breakdown</summary>
              @for (goal of report.goals; track $index) {
                <label>{{ goal.name }} · {{ goal.progress | zar }} of {{ goal.target | zar }}
                  <progress [value]="bounded(goal.progress, goal.target)" [max]="goal.target"></progress></label>
              }
            </details>
          }
          @if (report.recurring.length) {
            <details><summary>Forecast breakdown</summary>
              <icash-chart label="Confirmed recurring commitments in the selected period"
                [labels]="recurringChart(report).labels" [series]="recurringChart(report).series"/>
              @for (entry of report.recurring; track $index) {
                <div class="list-row"><span>{{ entry.name }}</span><strong>{{ entry.amount | zar }}</strong></div>
              }
            </details>
          }
          @if (detailed()) {
            <div class="list-row"><span>Prior period cash flow</span><strong>{{ report.prior.net | zar }}</strong></div>
            <div class="list-row"><span>Change in cash flow</span><strong>{{ report.net - report.prior.net | zar }}</strong></div>
          }
        </section>
      </div>
    } @else if (!ui.error()) { <mat-progress-spinner diameter="32" mode="indeterminate" aria-label="Loading report"/> }
  `,
})
export class ReportsPage {
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
  bounded(progress: number, target: number) { return Math.max(0, Math.min(progress, target)); }
  recurringChart(report: Report) { return this.cached(report, 'recurring', () => ({
    labels: report.recurring.slice(0, 6).map((row) => row.name),
    series: [{ label: 'Forecast', values: report.recurring.slice(0, 6).map((row) => row.amount), colour: '#49789a' }],
  })); }
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
        { label: 'Income', values: rows.map((row) => row.income), colour: '#61aa91' },
        { label: 'Spending', values: rows.map((row) => row.expense), colour: '#49789a' },
      ] };
    });
  }
  trendLabels(report: Report, range: number) { return this.trendChart(report, range).labels; }
  trendSeries(report: Report, range: number) { return this.trendChart(report, range).series; }
  private categoryChart(report: Report) {
    return this.cached(report, 'categories', () => ({
      labels: report.categories.slice(0, 6).map((row) => row.name),
      series: [{ label: 'Net spending', values: report.categories.slice(0, 6).map((row) => row.amount), colour: '#49789a' }],
    }));
  }
  categoryLabels(report: Report) { return this.categoryChart(report).labels; }
  categorySeries(report: Report) { return this.categoryChart(report).series; }
  budgetSeries(report: Report) { return this.cached(report, 'budget', () => ({
    labels: this.budgetLabels, series: [{ label: 'Household budget', values: [report.allocated, report.budgetActual], colour: '#61aa91' }],
  })).series; }
}
