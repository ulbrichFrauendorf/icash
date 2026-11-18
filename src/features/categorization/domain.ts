import { normalizeText } from '../../shared/finance';
import type { Rule } from './contract';

export type Classifiable = { accountId: string; description: string; merchant: string; amount: number };
export type Classification = { categoryId: string | null; treatment: 'expense' | 'income' | 'transfer'; classification: 'suggested' | 'rule' | 'merchant'; ruleId: string | null };
export type EligibleCategory = { id: string; kind: 'income' | 'expense' | 'transfer' | 'savings' };
export type Merchant = { merchant: string; direction: 'debit' | 'credit'; categoryId: string };

export function matches(row: Classifiable, rule: Rule['conditions']): boolean {
  if (rule.accountId && rule.accountId !== row.accountId) return false;
  if (rule.direction && rule.direction !== (row.amount < 0 ? 'debit' : 'credit')) return false;
  const amount = Math.abs(row.amount);
  if (rule.minimum !== undefined && amount < rule.minimum) return false;
  if (rule.maximum !== undefined && amount > rule.maximum) return false;
  if (!rule.text) return true;
  const value = normalizeText(row[rule.field]);
  const text = normalizeText(rule.text);
  if (rule.operator === 'contains') return value.includes(text);
  if (rule.operator === 'startsWith') return value.startsWith(text);
  return value === text;
}

export function classify(row: Classifiable, rules: Rule[], merchants: Merchant[], eligible: Map<string, EligibleCategory>): Classification & { conflicts: number } {
  const matching = rules.filter((rule) => rule.enabled && eligible.has(rule.categoryId) && matches(row, rule.conditions))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const merchant = merchants.find((entry) => entry.direction === (row.amount < 0 ? 'debit' : 'credit') &&
    entry.merchant === normalizeText(row.merchant || row.description) && eligible.has(entry.categoryId));
  const user = matching.find((rule) => rule.source === 'user');
  const winner = user ?? (merchant ? undefined : matching.find((rule) => rule.source === 'default'));
  const categoryId = winner?.categoryId ?? merchant?.categoryId ?? null;
  const kind = categoryId ? eligible.get(categoryId)?.kind : undefined;
  return {
    categoryId,
    treatment: kind === 'transfer' || kind === 'savings' ? 'transfer' : kind ?? (row.amount < 0 ? 'expense' : 'income'),
    classification: winner ? 'rule' : merchant ? 'merchant' : 'suggested',
    ruleId: winner?.id ?? null,
    conflicts: Math.max(0, new Set(matching.map((rule) => rule.categoryId)).size - 1),
  };
}
