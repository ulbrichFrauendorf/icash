import type { TableColumn } from 'invensys-ng';
import { formatZar } from './pipes';

export function sortableColumns(columns: TableColumn[]): TableColumn[] {
  return columns.map((column) => ({ sortable: true, ...column }));
}

export function currencyColumn(field: string, header: string): TableColumn {
  return { field, header, align: 'right' };
}

// ITable compares the numeric value and converts it to text when displaying or searching a cell.
export function tableMoney(value: number | null | undefined) {
  return value == null ? null : { toString: () => formatZar(value), valueOf: () => value };
}
