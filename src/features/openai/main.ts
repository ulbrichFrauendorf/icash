import { randomUUID } from 'node:crypto';
import type { Db } from '../../platform/main/database';
import { normalizeText } from '../../shared/finance';
import { UserError } from '../../shared/schema';
import { categories, saveCategory } from '../categories/main';
import type { Category } from '../categories/contract';
import { categorizer, listRules, saveRule } from '../categorization/main';
import type { Rule } from '../categorization/contract';
import { matches, type Classifiable } from '../categorization/domain';
import type { ProfileStore } from '../profiles/main';
import { saveTransaction, transactionDetail } from '../transactions/main';
import type { TransactionDetail } from '../transactions/contract';
import { OpenAiClient, type AiClient, type ModelSample, type ModelSuggestion } from './client';
import type { AiClassification, AiRule, AiRules, CategoryChoice, SuggestedCategory } from './contract';
import { ruleMatch, safeDescription, shorterMatch } from './descriptions';

const limit = 24;
type Profile = ReturnType<ProfileStore['active']>;
export type RuleEvidence = { description: string; amount: number; treatment: 'expense' | 'income' };
type PostedRow = Classifiable & RuleEvidence & { id: string };
type RulePattern = Pick<AiRule, 'name' | 'match' | 'direction'> & { sourceMatch: string };
type RuleSample = ModelSample & RulePattern & { samples: number };
export type RuleSuggestion = AiRule & Pick<RulePattern, 'sourceMatch'>;
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
const ruleConditions = (rule: Pick<RulePattern, 'direction' | 'match'>): Rule['conditions'] =>
  ({ field: 'description', operator: 'contains', direction: rule.direction, text: rule.match });
const ledgerMatches = (db: Db) => db.prepare<[number, string], { description: string }>(`SELECT DISTINCT description FROM transactions
  WHERE (amount < 0) = ? AND instr(normalized, ?) > 0`);

function overlapsLedger(matches: ReturnType<typeof ledgerMatches>, { direction, match, sourceMatch }: RulePattern): boolean {
  for (const row of matches.iterate(Number(direction === 'debit'), match)) {
    if (ruleMatch(row.description)?.match !== sourceMatch) return true;
  }
  return false;
}

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

export function rulePattern(row: RuleEvidence): RulePattern | null {
  const pattern = ruleMatch(row.description);
  return pattern && row.treatment === (row.amount < 0 ? 'expense' : 'income')
    ? { ...pattern, sourceMatch: pattern.match, direction: direction(row.amount) }
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

export function saveApprovedRules(db: Db, approvals: { pattern: RulePattern; categoryId: string }[]) {
  const existing = new Set(listRules(db).map((rule) => conditionKey(rule.conditions)));
  const created = new Set<string>();
  const matchingRows = ledgerMatches(db);
  for (const { pattern, categoryId } of approvals) {
    const conditions = ruleConditions(pattern);
    const key = conditionKey(conditions);
    if (existing.has(key) || overlapsLedger(matchingRows, pattern)) continue;
    const id = randomUUID();
    saveRule(db, { id, conditions, categoryId, name: pattern.name, priority: 9000, enabled: true });
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
  private rules?: Pending<{ token: string; rules: RuleSuggestion[] }>;
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

  private async request(profile: Profile, samples: ModelSample[], forRules = false) {
    const epoch = this.epoch;
    const all = categories(profile.db);
    const available = all.filter((category) => !category.archived && category.leaf &&
      samples.some((sample) => sample.kind === category.kind));
    const parents = new Map(all.map((category) => [category.id, category.name]));
    const choices = available.map((category, code) => ({
      code, name: categoryLabel(category, parents), kind: category.kind as ModelSample['kind'],
    }));
    const answers = await this.client.suggest(this.profiles.openAiKey(profile.id), samples, choices, forRules);
    this.ensureCurrent(profile, epoch);
    return { answers, available, all, parents };
  }

  async suggestTransaction(id: string): Promise<AiClassification> {
    const profile = this.profiles.active();
    this.transaction = undefined;
    const { transaction, kind } = transactionForAi(profile.db, id);
    let match = categorizer(profile.db)(transaction);
    let category: SuggestedCategory | null | undefined;
    let reason = '';
    if (!match.ruleId) {
      const description = safeDescription(transaction.merchant || transaction.description);
      if (!description) throw new UserError('This transaction has no usable merchant or description for AI classification.');
      const { answers, available, all, parents } = await this.request(profile, [{ index: 0, description, kind, direction: direction(transaction.amount) }]);
      const answer = answers.find((item) => item.index === 0);
      category = answer && proposal(answer, kind, available, all, parents);
      reason = answer?.reason ?? '';
      match = categorizer(profile.db)(transaction);
    }
    if (match.ruleId) {
      const all = categories(profile.db);
      const target = all.find((entry) => entry.id === match.categoryId && entry.kind === kind);
      if (!target) throw new UserError('An existing rule matches this transaction with a different treatment. Apply it from the Rules page.');
      const parents = new Map(all.map((entry) => [entry.id, entry.name]));
      category = { id: target.id, name: target.name, label: categoryLabel(target, parents), kind };
      reason = 'An existing rule matches this transaction.';
    }
    if (!category) throw new UserError('OpenAI could not suggest a category confidently. Use the transaction editor to choose one.');
    const value = { token: randomUUID(), category, reason, ruleId: match.ruleId ?? undefined };
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
      const match = categorizer(db)(transaction);
      if ((match.ruleId ?? undefined) !== value.ruleId ||
          (match.ruleId && (match.categoryId !== value.category.id || match.treatment !== kind))) {
        throw new UserError('The matching rule changed after the suggestion. Request a new suggestion.');
      }
      if (match.ruleId) {
        db.prepare("UPDATE transactions SET category_id=?,classification='rule',rule_id=? WHERE id=?")
          .run(match.categoryId, match.ruleId, transaction.id);
        return transactionDetail(db, transaction.id);
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
    const classify = categorizer(profile.db);
    const rules = await this.suggestForRows(rows.filter((row) => !classify(row).categoryId));
    this.rules = { db: profile.db, value: { token: randomUUID(), rules } };
    return this.rules.value;
  }

  async suggestForRows(rows: RuleEvidence[]): Promise<RuleSuggestion[]> {
    const profile = this.profiles.active();
    const existing = new Set(listRules(profile.db).map((rule) => conditionKey(rule.conditions)));
    const grouped = new Map<string, RuleSample>();
    const evidence = new Map<string, { description: string; match: string | undefined; direction: RulePattern['direction'] }>();
    for (const row of rows) {
      const sample = rulePattern(row);
      const source = normalizeText(row.description);
      const flow = direction(row.amount);
      evidence.set(JSON.stringify([flow, source]), { description: source, match: sample?.match, direction: flow });
      const description = sample && safeDescription(sample.match);
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
    const { answers, available, all, parents } = await this.request(profile, payload, true);
    const matchingRows = ledgerMatches(profile.db);
    const descriptions = [...evidence.values()];
    const overlaps = (sample: RuleSample, match: string) =>
      descriptions.some((row) => row.direction === sample.direction && row.match !== sample.match && row.description.includes(match)) ||
      overlapsLedger(matchingRows, { ...sample, match });
    const used = new Set<number>();
    const proposed = new Set<string>();
    const rules: RuleSuggestion[] = [];
    for (const answer of answers) {
      const sample = samples[answer.index];
      if (!sample || used.has(sample.index)) continue;
      const category = proposal(answer, sample.kind, available, all, parents);
      if (!category) continue;
      used.add(sample.index);
      const shorter = answer.ruleMatch && shorterMatch(answer.ruleMatch, sample.match);
      let match = shorter || sample.match;
      if (overlaps(sample, match)) {
        if (match === sample.match || overlaps(sample, sample.match)) continue;
        match = sample.match;
      }
      const key = patternKey({ match, direction: sample.direction });
      if (existing.has(key) || proposed.has(key)) continue;
      proposed.add(key);
      const name = answer.ruleName && /^[\p{L}\p{N}][\p{L}\p{N}\p{M} &'’().,-]*$/u.test(answer.ruleName)
        && (normalizeText(answer.ruleName) !== sample.description || normalizeText(sample.name) === sample.description)
        ? answer.ruleName : sample.name;
      rules.push({ index: sample.index, name, match, sourceMatch: sample.sourceMatch, operator: 'contains', direction: sample.direction,
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
      const existing = new Set(listRules(db).map((rule) => conditionKey(rule.conditions)));
      const matchingRows = ledgerMatches(db);
      const eligibleRows = db.prepare(eligibleSql).all() as PostedRow[];
      const classifyExisting = categorizer(db);
      const approvals = rules.flatMap((rule) => {
        const choice = selection.get(rule.index);
        if (!choice || existing.has(patternKey(rule))) return [];
        if (overlapsLedger(matchingRows, rule)) throw new UserError('A transaction now overlaps a suggested rule. Generate new rule suggestions.');
        const conditions = ruleConditions(rule);
        const samples = eligibleRows.filter((row) => matches(row, conditions));
        if (samples.length && samples.every((row) => classifyExisting(row).categoryId)) return [];
        const id = resolveCategoryChoice(db, choice, rule.category.kind, rule.category);
        return id ? [{ pattern: rule, categoryId: id }] : [];
      });
      const created = saveApprovedRules(db, approvals);
      let classified = 0;
      if (applyToImported && created.size) {
        const classify = categorizer(db);
        const update = db.prepare("UPDATE transactions SET category_id=?,classification='rule',rule_id=? WHERE id=?");
        for (const row of eligibleRows) {
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
