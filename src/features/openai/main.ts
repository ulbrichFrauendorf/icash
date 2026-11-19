import { randomUUID } from 'node:crypto';
import type { Db } from '../../platform/main/database';
import { normalizeText } from '../../shared/finance';
import { UserError } from '../../shared/schema';
import { categories, saveCategory } from '../categories/main';
import type { Category } from '../categories/contract';
import { categorizer, listRules, saveRule } from '../categorization/main';
import type { Rule } from '../categorization/contract';
import type { Classifiable } from '../categorization/domain';
import type { ProfileStore } from '../profiles/main';
import { saveTransaction, transactionDetail } from '../transactions/main';
import type { TransactionDetail } from '../transactions/contract';
import { OpenAiClient, type AiClient, type ModelSample, type ModelSuggestion } from './client';
import type { AiClassification, AiRule, AiRules, CategoryChoice, SuggestedCategory } from './contract';
import { ruleMatch, safeDescription } from './descriptions';

const limit = 24;
type Profile = ReturnType<ProfileStore['active']>;
export type RuleEvidence = { description: string; amount: number; treatment: 'expense' | 'income' };
type PostedRow = Classifiable & RuleEvidence & { id: string };
type RuleSample = ModelSample & { match: string; operator: 'contains' | 'equals'; samples: number };
type Pending<T> = { db: Db; value: T };

const eligibleSql = `SELECT t.id,t.account_id AS accountId,t.description,t.merchant,t.amount,t.treatment
  FROM transactions t WHERE t.category_id IS NULL AND t.classification<>'manual' AND t.treatment IN ('expense','income')
  AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id=t.id)
  AND NOT EXISTS (SELECT 1 FROM transfer_legs p WHERE p.transaction_id=t.id)`;
const direction = (amount: number): ModelSample['direction'] => amount < 0 ? 'debit' : 'credit';
const conditionKey = (condition: Rule['conditions']) => JSON.stringify([
  condition.field, condition.operator, normalizeText(condition.text ?? ''), condition.direction,
  condition.accountId, condition.minimum, condition.maximum,
]);
const ruleConditions = (rule: Pick<AiRule, 'operator' | 'direction' | 'match'>): Rule['conditions'] =>
  ({ field: 'description', operator: rule.operator, direction: rule.direction, text: rule.match });

function categoryLabel(category: Category, parents: ReadonlyMap<string, string>) {
  const parent = category.parentId && parents.get(category.parentId);
  return parent ? parent + ' / ' + category.name : category.name;
}

function sameName(value: string, list: Category[]) {
  return list.find((category) => normalizeText(category.name) === normalizeText(value) && !category.archived);
}

function proposal(
  answer: ModelSuggestion, kind: ModelSample['kind'], available: Category[], all: Category[], parents: ReadonlyMap<string, string>,
): SuggestedCategory | null {
  if (answer.category !== null) {
    const match = available[answer.category];
    return match?.kind === kind ? { id: match.id, name: match.name, label: categoryLabel(match, parents), kind } : null;
  }
  if (kind !== 'expense' || !answer.newExpense || !/^\p{L}[\p{L}\p{M} &'’()/,.-]*$/u.test(answer.newExpense)) return null;
  const name = answer.newExpense;
  const match = sameName(name, all);
  if (match && (!match.leaf || match.kind !== kind)) return null;
  return { id: match?.id ?? null, name: match?.name ?? name, label: match ? categoryLabel(match, parents) : name, kind };
}

function categoryId(db: Db, category: SuggestedCategory): string {
  const current = categories(db);
  if (category.id) {
    if (!current.some((entry) => entry.id === category.id && entry.kind === category.kind && entry.leaf && !entry.archived && entry.name === category.name)) {
      throw new UserError('The suggested category has changed. Request a new suggestion.');
    }
    return category.id;
  }
  const existing = sameName(category.name, current);
  if (existing?.kind === 'expense' && existing.leaf) return existing.id;
  if (existing) throw new UserError('A category now uses the suggested name. Request a new suggestion.');
  const list = saveCategory(db, { parentId: null, kind: 'expense', name: category.name, colour: '#278473',
    icon: '', sort: 0, archived: false, excludeReports: false });
  return list.find((entry) => entry.parentId === null && entry.name === category.name && !entry.archived)!.id;
}

export function rulePattern(row: RuleEvidence) {
  const pattern = ruleMatch(row.description);
  return pattern && row.treatment === (row.amount < 0 ? 'expense' : 'income')
    ? { match: pattern.text, operator: pattern.operator, direction: direction(row.amount) }
    : null;
}

export const patternKey = (rule: Parameters<typeof ruleConditions>[0]) => conditionKey(ruleConditions(rule));

export function resolveCategoryChoice(
  db: Db, choice: CategoryChoice, kind: SuggestedCategory['kind'], suggested?: SuggestedCategory,
): string | null {
  if (!choice) return null;
  if (choice === 'suggested') {
    if (!suggested || suggested.kind !== kind) throw new UserError('The suggested category is no longer available.');
    return categoryId(db, suggested);
  }
  if (!categories(db).some((category) => category.id === choice && category.kind === kind && category.leaf && !category.archived)) {
    throw new UserError('Choose an active category of the matching type.');
  }
  return choice;
}

export function saveApprovedRules(db: Db, approvals: { pattern: Parameters<typeof ruleConditions>[0]; categoryId: string }[]) {
  const existing = new Set(listRules(db).map((rule) => conditionKey(rule.conditions)));
  const created = new Set<string>();
  for (const { pattern, categoryId } of approvals) {
    const conditions = ruleConditions(pattern);
    const key = conditionKey(conditions);
    if (existing.has(key)) continue;
    const id = randomUUID();
    saveRule(db, { id, conditions, categoryId, name: pattern.match.slice(0, 80), priority: 9000, enabled: true });
    created.add(id);
    existing.add(key);
  }
  return created;
}

function transactionForAi(db: Db, id: string) {
  const transaction = transactionDetail(db, id);
  if (transaction.pairId || transaction.hasSplits || transaction.treatment === 'transfer') {
    throw new UserError('Classify transfers and split transactions manually.');
  }
  return { transaction, kind: transaction.treatment };
}

function fingerprint(row: TransactionDetail) {
  return JSON.stringify([row.categoryId, row.treatment, row.description, row.merchant, row.classification]);
}

export class AiCategorization {
  private transaction?: Pending<AiClassification & { id: string; fingerprint: string }>;
  private rules?: Pending<AiRules>;
  private epoch = 0;

  constructor(private readonly profiles: ProfileStore, private readonly client: AiClient = new OpenAiClient()) {}

  clear() {
    this.epoch++;
    this.transaction = undefined;
    this.rules = undefined;
  }

  status() { return { connected: this.profiles.hasOpenAiKey(this.profiles.active().id) }; }

  private ensureCurrent(profile: Profile, epoch: number) {
    if (epoch !== this.epoch || !profile.db.open || this.profiles.active().db !== profile.db) {
      throw new UserError('The active household or OpenAI connection changed. Try again.');
    }
  }

  async connect(key: string) {
    const profile = this.profiles.active();
    const epoch = this.epoch;
    await this.client.test(key);
    this.ensureCurrent(profile, epoch);
    this.profiles.setOpenAiKey(profile.id, key);
    this.clear();
    return this.status();
  }

  disconnect() {
    this.profiles.setOpenAiKey(this.profiles.active().id, null);
    this.clear();
    return this.status();
  }

  private async request(profile: Profile, samples: ModelSample[]) {
    const epoch = this.epoch;
    const all = categories(profile.db);
    const available = all.filter((category) => !category.archived && category.leaf &&
      samples.some((sample) => sample.kind === category.kind));
    const parents = new Map(all.map((category) => [category.id, category.name]));
    const choices = available.map((category, code) => ({
      code, name: categoryLabel(category, parents), kind: category.kind as ModelSample['kind'],
    }));
    const answers = await this.client.suggest(this.profiles.openAiKey(profile.id), samples, choices);
    this.ensureCurrent(profile, epoch);
    return { answers, available, all, parents };
  }

  async suggestTransaction(id: string): Promise<AiClassification> {
    const profile = this.profiles.active();
    this.transaction = undefined;
    const { transaction, kind } = transactionForAi(profile.db, id);
    const description = safeDescription(transaction.merchant || transaction.description);
    if (!description) throw new UserError('This transaction has no usable merchant or description for AI classification.');
    const { answers, available, all, parents } = await this.request(profile, [{ index: 0, description, kind, direction: direction(transaction.amount) }]);
    const answer = answers.find((item) => item.index === 0);
    const category = answer && proposal(answer, kind, available, all, parents);
    if (!category || !answer) throw new UserError('OpenAI could not suggest a category confidently. Use the transaction editor to choose one.');
    const value = { token: randomUUID(), category, reason: answer.reason };
    this.transaction = { db: profile.db, value: { ...value, id, fingerprint: fingerprint(transaction) } };
    return value;
  }

  applyTransaction(token: string) {
    const db = this.profiles.active().db;
    const pending = this.transaction;
    if (!pending || pending.value.token !== token || pending.db !== db) throw new UserError('Request a new category suggestion first.');
    const { value } = pending;
    const saved = db.transaction(() => {
      const { transaction, kind } = transactionForAi(db, value.id);
      if (kind !== value.category.kind || fingerprint(transaction) !== value.fingerprint) {
        throw new UserError('This transaction changed after the suggestion. Request a new suggestion.');
      }
      return saveTransaction(db, { ...transaction, categoryId: categoryId(db, value.category), confirmClassification: true });
    }).immediate();
    this.transaction = undefined;
    return saved;
  }

  async suggestRules(): Promise<AiRules> {
    const profile = this.profiles.active();
    this.rules = undefined;
    const rows = profile.db.prepare(eligibleSql + ' ORDER BY t.date DESC,t.id LIMIT 500').all() as PostedRow[];
    const rules = await this.suggestForRows(rows);
    this.rules = { db: profile.db, value: { token: randomUUID(), rules } };
    return this.rules.value;
  }

  async suggestForRows(rows: RuleEvidence[]): Promise<AiRule[]> {
    const profile = this.profiles.active();
    const existing = new Set(listRules(profile.db).map((rule) => conditionKey(rule.conditions)));
    const grouped = new Map<string, RuleSample>();
    for (const row of rows) {
      const sample = rulePattern(row);
      const description = safeDescription(row.description);
      if (!sample || !description) continue;
      const key = patternKey(sample);
      if (existing.has(key)) continue;
      const group = grouped.get(key);
      if (group) group.samples++;
      else grouped.set(key, { ...sample, description, kind: row.treatment, index: 0, samples: 1 });
    }
    const samples = [...grouped.values()].sort((a, b) => b.samples - a.samples).slice(0, limit)
      .map((sample, index) => ({ ...sample, index }));
    if (!samples.length) return [];
    const payload = samples.map(({ index, description, kind, direction }) => ({ index, description, kind, direction }));
    const { answers, available, all, parents } = await this.request(profile, payload);
    const used = new Set<number>();
    const rules: AiRule[] = [];
    for (const answer of answers) {
      const sample = samples[answer.index];
      if (!sample || used.has(sample.index)) continue;
      const category = proposal(answer, sample.kind, available, all, parents);
      if (!category) continue;
      used.add(sample.index);
      rules.push({ index: sample.index, match: sample.match, operator: sample.operator, direction: sample.direction,
        samples: sample.samples, category, reason: answer.reason });
    }
    return rules;
  }

  applyRules(token: string, selected: { index: number; choice: CategoryChoice }[], applyToImported: boolean) {
    const db = this.profiles.active().db;
    const pending = this.rules;
    if (!pending || pending.db !== db || pending.value.token !== token) throw new UserError('Generate new rule suggestions first.');
    const selection = new Map(selected.map(({ index, choice }) => [index, choice]));
    const rules = pending.value.rules.filter((rule) => selection.has(rule.index));
    if (!rules.length || rules.length !== selection.size) throw new UserError('Select valid rule suggestions.');
    const result = db.transaction(() => {
      const approvals = rules.flatMap((rule) => {
        const id = resolveCategoryChoice(db, selection.get(rule.index) ?? '', rule.category.kind, rule.category);
        return id ? [{ pattern: rule, categoryId: id }] : [];
      });
      const created = saveApprovedRules(db, approvals);
      let classified = 0;
      if (applyToImported && created.size) {
        const classify = categorizer(db);
        const update = db.prepare("UPDATE transactions SET category_id=?,classification='rule',rule_id=? WHERE id=?");
        for (const row of db.prepare(eligibleSql).all() as PostedRow[]) {
          const suggestion = classify(row);
          if (!suggestion.ruleId || !created.has(suggestion.ruleId) || suggestion.treatment !== row.treatment) continue;
          classified += update.run(suggestion.categoryId, suggestion.ruleId, row.id).changes;
        }
      }
      return { rules: listRules(db), created: created.size, classified };
    }).immediate();
    this.rules = undefined;
    return result;
  }
}
