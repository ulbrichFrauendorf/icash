import { Component, computed, input } from '@angular/core';
import { IChart, type IChartData } from 'invensys-ng';

@Component({
  selector: 'icash-chart',
  imports: [IChart],
  templateUrl: './chart.component.html',
})
export class ReportChart {
  readonly label = input.required<string>();
  readonly labels = input.required<string[]>();
  readonly series = input.required<{ label: string; values: number[]; colour: string }[]>();
  readonly type = input<IChartData['chartType']>('bar');
  readonly charts = computed((): IChartData[] => [{
    chartType: this.type(),
    labels: this.labels(),
    dataSets: this.series().map((series) => ({
      label: series.label,
      data: series.values.map((amount) => amount / 100),
      backgroundColors: [series.colour],
    })),
  }]);
}
