import { Pipe, type PipeTransform } from '@angular/core';

const whole = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 });

export function formatZar(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    const absolute = BigInt(Math.abs(value));
    return (value < 0 ? '−' : '') + 'R\u00a0' + whole.format(absolute / 100n) + ',' + String(absolute % 100n).padStart(2, '0');
}

@Pipe({ name: 'zar' })
export class ZarPipe implements PipeTransform {
    transform = formatZar;
}
