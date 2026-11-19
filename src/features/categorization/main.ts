import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Db } from '../../platform/main/database';
import { normalizeText } from '../../shared/finance';
import { UserError } from '../../shared/schema';
import { categories } from '../categories/main';
import type { merchantInput, Rule, RulePreview, saveRuleInput } from './contract';
import { classify, type Classifiable, type Classification, type Merchant } from './domain';

export function listRules(db: Db): Rule[] {
  return (db.prepare('SELECT id,name,category_id AS categoryId,conditions,priority,enabled,source FROM rules ORDER BY source DESC,priority,id')
    .all() as (Omit<Rule, 'conditions'> & { conditions: string })[])
    .map((rule) => ({ ...rule, enabled: Boolean(rule.enabled), conditions: JSON.parse(rule.conditions) as Rule['conditions'] }));
}

export function saveRule(db: Db, input: z.infer<typeof saveRuleInput>) {
  if (!categories(db).some((entry) => entry.id === input.categoryId && entry.leaf && !entry.archived)) {
    throw new UserError('Select an active category within a group.');
  }
  if (input.conditions.accountId && !db.prepare('SELECT id FROM accounts WHERE id=?').get(input.conditions.accountId)) {
    throw new UserError('The rule account was not found.');
  }
  db.prepare(`
    INSERT INTO rules(id,name,category_id,conditions,priority,enabled,source)
    VALUES(@id,@name,@categoryId,@conditions,@priority,@enabled,'user')
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,category_id=excluded.category_id,conditions=excluded.conditions,
      priority=excluded.priority,enabled=excluded.enabled
  `).run({ ...input, id: input.id ?? randomUUID(), conditions: JSON.stringify(input.conditions), enabled: Number(input.enabled) });
  return listRules(db);
}

export function saveMerchant(db: Db, input: z.infer<typeof merchantInput>) {
  if (!categories(db).some((entry) => entry.id === input.categoryId && entry.leaf && !entry.archived)) {
    throw new UserError('Select an active category within a group.');
  }
  db.prepare(`INSERT INTO merchant_mappings(merchant,direction,category_id) VALUES(?,?,?)
    ON CONFLICT(merchant,direction) DO UPDATE SET category_id=excluded.category_id`)
    .run(normalizeText(input.merchant), input.direction, input.categoryId);
}

export function categorizer(db: Db) {
  const rules = listRules(db);
  const mappings = db.prepare('SELECT merchant,direction,category_id AS categoryId FROM merchant_mappings').all() as Merchant[];
  const eligible = new Map(categories(db).filter((category) => !category.archived && category.leaf)
    .map((category) => [category.id, category] as const));
  return (row: Classifiable) => classify(row, rules, mappings, eligible);
}

export function recategorize(db: Db, apply: boolean): RulePreview {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id,account_id AS accountId,description,merchant,amount,treatment,category_id AS categoryId,
      classification,rule_id AS ruleId FROM transactions ORDER BY date,id`).all() as
      (Classifiable & Omit<Classification, 'classification'> & { id: string; classification: string })[];
    const write = db.prepare('UPDATE transactions SET category_id=?,treatment=?,classification=?,rule_id=? WHERE id=?');
    const classifyRow = categorizer(db);
    const result: RulePreview = { changes: 0, protected: 0, conflicts: 0, sample: [] };
    for (const row of rows) {
      if (row.classification === 'manual') { result.protected++; continue; }
      const next = classifyRow(row);
      if (next.conflicts) result.conflicts++;
      if (next.categoryId === row.categoryId && next.treatment === row.treatment &&
        next.classification === row.classification && next.ruleId === row.ruleId) continue;
      result.changes++;
      if (result.sample.length < 100) result.sample.push({ id: row.id, description: row.description, from: row.categoryId, to: next.categoryId });
      if (apply) write.run(next.categoryId, next.treatment, next.classification, next.ruleId, row.id);
    }
    return result;
  })();
}
