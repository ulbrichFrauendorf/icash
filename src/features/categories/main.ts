import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Db } from '../../platform/main/database';
import { UserError } from '../../shared/schema';
import { defaultRules, householdTemplate, householdTemplateVersion } from './template';
import type { Category, deleteCategoryInput, saveCategoryInput } from './contract';

export function categories(db: Db): Category[] {
  const rows = db.prepare(`
    SELECT id,parent_id AS parentId,template_key AS templateKey,name,kind,colour,icon,sort,archived,
      exclude_reports AS excludeReports, parent_id IS NOT NULL AS leaf
    FROM categories c ORDER BY sort,name,id
  `).all() as Category[];
  return rows.map((row) => ({
    ...row, leaf: Boolean(row.leaf), archived: Boolean(row.archived), excludeReports: Boolean(row.excludeReports),
  }));
}

function usage(db: Db, id: string) {
  return db.prepare(`
    SELECT
      (SELECT count(*) FROM transactions WHERE category_id=@id) AS transactions,
      (SELECT count(*) FROM splits WHERE category_id=@id) AS splits,
      (SELECT count(*) FROM rules WHERE category_id=@id) AS rules,
      (SELECT count(*) FROM merchant_mappings WHERE category_id=@id) AS merchants,
      (SELECT count(*) FROM monthly_allocations WHERE category_id=@id) AS allocations,
      (SELECT count(*) FROM budget_defaults WHERE category_id=@id) AS defaults
  `).get({ id }) as Record<string, number>;
}

export function saveCategory(db: Db, input: z.infer<typeof saveCategoryInput>): Category[] {
  const list = categories(db);
  const existing = list.find((category) => category.id === input.id);
  const parent = list.find((category) => category.id === input.parentId);
  if (input.id && !existing) throw new UserError('Category was not found.');
  if (input.parentId && (!parent || parent.parentId || parent.id === input.id || parent.kind !== input.kind ||
      (!input.archived && parent.archived) || (existing && !existing.leaf))) {
    throw new UserError('Choose a group with the same category type.');
  }
  if (existing && Boolean(input.parentId) !== existing.leaf) throw new UserError('A category must stay in a group. Create a separate group to reorganize it.');
  if (existing && existing.kind !== input.kind && (!existing.leaf || Object.values(usage(db, existing.id)).some(Boolean))) {
    throw new UserError('This category is in use. Create a category of the desired type.');
  }
  if (input.archived && list.some((child) => child.parentId === input.id && !child.archived)) {
    throw new UserError('Archive or move the active subcategories first.');
  }
  if (!input.archived && list.some((category) => category.id !== input.id && !category.archived &&
      category.parentId === input.parentId && category.name.toLowerCase() === input.name.toLowerCase())) {
    throw new UserError('An active category already uses that name here.');
  }
  db.prepare(`
    INSERT INTO categories(id,parent_id,name,kind,colour,icon,sort,archived,exclude_reports)
    VALUES(@id,@parentId,@name,@kind,@colour,@icon,@sort,@archived,@excludeReports)
    ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,kind=excluded.kind,
      colour=excluded.colour,icon=excluded.icon,sort=excluded.sort,archived=excluded.archived,exclude_reports=excluded.exclude_reports
  `).run({ ...input, id: input.id ?? randomUUID(), archived: Number(input.archived), excludeReports: Number(input.excludeReports) });
  return categories(db);
}

export function previewCategoryDeletion(db: Db, id: string) {
  if (!db.prepare('SELECT id FROM categories WHERE id=?').get(id)) throw new UserError('Category was not found.');
  if (db.prepare('SELECT id FROM categories WHERE parent_id=? LIMIT 1').get(id)) {
    throw new UserError('Move or delete the categories in this group first.');
  }
  const used = usage(db, id);
  const transfer = db.prepare("SELECT 1 FROM transfer_legs WHERE json_extract(previous,'$.category_id')=? LIMIT 1").get(id);
  if (used.transactions || used.splits || used.allocations || used.defaults || transfer) {
    throw new UserError('This category is used in the ledger or a budget. Archive it to keep its history.');
  }
  const rules = db.prepare('SELECT id FROM rules WHERE category_id=? ORDER BY id').all(id) as { id: string }[];
  return { ruleIds: rules.map((rule) => rule.id) };
}

export function deleteCategory(db: Db, input: z.infer<typeof deleteCategoryInput>): Category[] {
  return db.transaction(() => {
    const { id, expectedRuleIds } = input;
    const { ruleIds } = previewCategoryDeletion(db, id);
    if (JSON.stringify(ruleIds) !== JSON.stringify([...expectedRuleIds].sort())) {
      throw new UserError('The linked rules changed. Review the deletion again.');
    }
    db.prepare(`UPDATE transactions SET rule_id=NULL, classification='manual'
      WHERE rule_id IN (SELECT id FROM rules WHERE category_id=?)`).run(id);
    db.prepare(`UPDATE transfer_legs SET previous=json_set(previous, '$.rule_id', NULL, '$.classification', 'manual')
      WHERE json_extract(previous, '$.rule_id') IN (SELECT id FROM rules WHERE category_id=?)`).run(id);
    db.prepare('DELETE FROM rules WHERE category_id=?').run(id);
    db.prepare('DELETE FROM merchant_mappings WHERE category_id=?').run(id);
    db.prepare('DELETE FROM categories WHERE id=?').run(id);
    return categories(db);
  }).immediate();
}

export function restoreDefaults(db: Db): Category[] {
  return db.transaction(() => {
    const find = db.prepare('SELECT id,kind,archived,parent_id FROM categories WHERE template_key=?');
    const collision = db.prepare('SELECT id FROM categories WHERE parent_id IS ? AND name=? AND archived=0');
    const insert = db.prepare('INSERT INTO categories(id,parent_id,template_key,name,kind,colour,sort) VALUES(?,?,?,?,?,?,?)');
    const restore = (key: string, label: string, kind: string, parent: string | null, sort: number) => {
      const existing = find.get(key) as { id: string; kind: string; archived: number; parent_id: string | null } | undefined;
      if (existing) return !existing.archived && existing.kind === kind && existing.parent_id === parent ? existing.id : null;
      if (collision.get(parent, label)) return null;
      const id = randomUUID();
      insert.run(id, parent, key, label, kind, '#278473', sort);
      return id;
    };
    for (const [index, [key, label, kind, children]] of householdTemplate.entries()) {
      const parent = restore(key, label, kind, null, index * 100);
      if (!parent || Object.values(usage(db, parent)).some(Boolean)) continue;
      for (const [childIndex, child] of children.entries()) restore(`${key}.${childIndex}`, child, kind, parent, index * 100 + childIndex + 1);
    }
    const insertRule = db.prepare(`
      INSERT OR IGNORE INTO rules(id,name,category_id,conditions,priority,enabled,source,template_key)
      VALUES(?,?,?,?,100,1,'default',?)
    `);
    db.prepare('UPDATE profile SET template_version=?').run(householdTemplateVersion);
    for (const [key, text, category] of defaultRules) {
      const target = find.get(category) as { id: string; archived: number } | undefined;
      if (target && !target.archived) {
        insertRule.run(randomUUID(), text, target.id, JSON.stringify({ field: 'description', operator: 'contains', text, direction: 'debit' }), key);
      }
    }
    return categories(db);
  })();
}
