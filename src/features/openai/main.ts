import { randomUUID } from 'node:crypto';
import type { Db } from '../../platform/main/database';
import { normalizeText } from '../../shared/finance';
import { UserError } from '../../shared/schema';
import { categories, saveCategory } from '../categories/main';
import { defaultGroup } from '../categories/template';
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
type RuleSample = { key: string; description: string; kind: ModelSample['kind']; direction: ModelSample['direction']; pattern: RulePattern | null; samples: number };
export type RuleSuggestion = AiRule & Pick<RulePattern, 'sourceMatch'>;
export type ReviewSuggestion = { category: SuggestedCategory; rule?: RuleSuggestion };
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

function proposal(
  answer: ModelSuggestion, kind: ModelSample['kind'], available: Category[], all: Category[], parents: ReadonlyMap<string, string>,
): SuggestedCategory | null {
  if (answer.category !== null) {
    const match = available[answer.category];
    return match?.kind === kind ? { id: match.id, name: match.name, label: categoryLabel(match, parents), kind } : null;
  }
  if (kind !== 'expense' || !answer.newExpense || !/^\p{L}[\p{L}\p{M} &'’()/,.-]*$/u.test(answer.newExpense)) return null;
  const name = answer.newExpense;
  const sameLeaves = available.filter((entry) => entry.kind === kind && normalizeText(entry.name) === normalizeText(name));
  if (!answer.newExpenseGroup && sameLeaves.length === 1) {
    const leaf = sameLeaves[0]!;
    return { id: leaf.id, name: leaf.name, label: categoryLabel(leaf, parents), kind };
  }
  const group = answer.newExpenseGroup || defaultGroup(kind, name);
  const parent = all.find((entry) => !entry.parentId && !entry.archived && normalizeText(entry.name) === normalizeText(group));
  if ((parent && parent.kind !== kind) || normalizeText(group) === normalizeText(name) ||
      all.some((entry) => !entry.parentId && !entry.archived && normalizeText(entry.name) === normalizeText(name))) return null;
  const match = available.find((entry) => parent && entry.parentId === parent.id && normalizeText(entry.name) === normalizeText(name));
  return { id: match?.id ?? null, name: match?.name ?? name, label: match ? categoryLabel(match, parents) : group + ' / ' + name, group, kind };
}

function categoryId(db: Db, category: SuggestedCategory): string {
  const current = categories(db);
  if (category.id) {
    if (!current.some((entry) => entry.id === category.id && entry.kind === category.kind && entry.leaf && !entry.archived && entry.name === category.name)) {
      throw new UserError('The suggested category has changed. Request a new suggestion.');
    }
    return category.id;
  }
  const groupName = category.group ?? defaultGroup('expense', category.name);
  let parent = current.find((entry) => !entry.parentId && !entry.archived && normalizeText(entry.name) === normalizeText(groupName));
  const fields = { kind: 'expense' as const, colour: '#278473', icon: '', sort: 0, archived: false, excludeReports: false };
  if (!parent) {
    const groups = saveCategory(db, { ...fields, parentId: null, name: groupName });
    parent = groups.find((entry) => !entry.parentId && !entry.archived && entry.name === groupName);
  }
  if (!parent || parent.kind !== 'expense') throw new UserError('Choose an expense category group.');
  const existing = current.find((entry) => entry.parentId === parent.id && !entry.archived &&
    normalizeText(entry.name) === normalizeText(category.name));
  if (existing) return existing.id;
  const list = saveCategory(db, { ...fields, parentId: parent.id, name: category.name });
  return list.find((entry) => entry.parentId === parent.id && entry.name === category.name && !entry.archived)!.id;
}

export function rulePattern(row: RuleEvidence): RulePattern | null {
  const pattern = ruleMatch(row.description);
  return pattern && row.treatment === (row.amount < 0 ? 'expense' : 'income')
    ? { ...pattern, sourceMatch: pattern.match, direction: direction(row.amount) }
    : null;
}

export function reviewSample(row: RuleEvidence) {
  const description = safeDescription(row.description);
  const pattern = rulePattern(row);
  const flow = direction(row.amount);
  return { description, pattern, direction: flow, kind: row.treatment,
    key: JSON.stringify([flow, row.treatment, description, pattern?.sourceMatch]) };
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
    const groups = all.filter((entry) => !entry.parentId && !entry.archived && entry.kind === 'expense').map((entry) => entry.name);
    const answers = await this.client.suggest(this.profiles.openAiKey(profile.id), samples, choices, forRules, groups);
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
    const { suggestions } = await this.suggestForRows(rows.filter((row) => !classify(row).categoryId));
    const rules = [...suggestions.values()].flatMap(({ rule }) => rule ? [rule] : []);
    this.rules = { db: profile.db, value: { token: randomUUID(), rules } };
    return this.rules.value;
  }

  async suggestForRows(rows: RuleEvidence[], forImport = false) {
    const profile = this.profiles.active();
    const epoch = this.epoch;
    const existing = new Set(listRules(profile.db).map((rule) => conditionKey(rule.conditions)));
    const hasIncome = categories(profile.db).some((category) => category.kind === 'income' && category.leaf && !category.archived);
    const grouped = new Map<string, RuleSample>();
    const evidence = new Map<string, { description: string; key: string; direction: RulePattern['direction'] }>();
    for (const row of rows) {
      const sample = reviewSample(row);
      const source = normalizeText(row.description);
      evidence.set(JSON.stringify([sample.direction, source]), { description: source, key: sample.key, direction: sample.direction });
      if (!sample.description || row.amount === 0 || (row.treatment === 'income' && !hasIncome)) continue;
      if (!forImport && (!sample.pattern || existing.has(patternKey(sample.pattern)))) continue;
      const group = grouped.get(sample.key);
      if (group) group.samples++;
      else grouped.set(sample.key, { ...sample, samples: 1 });
    }
    const ranked = [...grouped.values()].sort((a, b) => b.samples - a.samples);
    const samples = forImport ? ranked : ranked.slice(0, limit);
    const suggestions = new Map<string, ReviewSuggestion>();
    const matchingRows = ledgerMatches(profile.db);
    const descriptions = [...evidence.values()];
    const canMatch = (sample: RuleSample, pattern: RulePattern) =>
      !descriptions.some((row) => row.direction === pattern.direction && row.key !== sample.key && row.description.includes(pattern.match)) &&
      !overlapsLedger(matchingRows, pattern);
    let notice: string | undefined;
    for (let start = 0; start < samples.length; start += limit) {
      const batch = samples.slice(start, start + limit);
      const payload = batch.map(({ description, kind, direction }, index) => ({ index, description, kind, direction }));
      let response;
      try {
        response = await this.request(profile, payload, true);
      } catch (error) {
        this.ensureCurrent(profile, epoch);
        if (!forImport || start === 0 || !(error instanceof UserError)) throw error;
        notice = error.message + ' Earlier suggestions are available for review.';
        break;
      }
      for (const answer of response.answers) {
        const sample = batch[answer.index];
        if (!sample || suggestions.has(sample.key)) continue;
        const category = proposal(answer, sample.kind, response.available, response.all, response.parents);
        if (!category) continue;
        const suggestion: ReviewSuggestion = { category };
        suggestions.set(sample.key, suggestion);
        const pattern = sample.pattern;
        if (!pattern || answer.ruleMatch === null) continue;
        const shorter = answer.ruleMatch && shorterMatch(answer.ruleMatch, pattern.match);
        let match = shorter || pattern.match;
        if (!canMatch(sample, { ...pattern, match })) {
          if (match === pattern.match || !canMatch(sample, pattern)) continue;
          match = pattern.match;
        }
        const key = patternKey({ match, direction: pattern.direction });
        if (existing.has(key)) continue;
        existing.add(key);
        const name = answer.ruleName && /^[\p{L}\p{N}][\p{L}\p{N}\p{M} &'’().,-]*$/u.test(answer.ruleName)
          && (normalizeText(answer.ruleName) !== sample.description || normalizeText(pattern.name) === sample.description)
          ? answer.ruleName : pattern.name;
        suggestion.rule = { ...pattern, index: answer.index, name, match, operator: 'contains', samples: sample.samples,
          category, reason: answer.reason };
      }
    }
    return { suggestions, notice };
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
