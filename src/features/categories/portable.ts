import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../platform/main/database';
import { UserError } from '../../shared/schema';
import { conditions } from '../categorization/contract';
import { listRules, saveRule } from '../categorization/main';
import { categoryFields } from './contract';
import { categories, saveCategory } from './main';

const item = categoryFields.omit({ archived: true }).extend({
  key: z.string().min(1).max(100), parent: z.string().min(1).max(100).nullable(),
});
const rule = z.object({
  name: z.string().trim().min(1).max(80), category: z.string().min(1).max(100),
  conditions, priority: z.int().min(0).max(9999), enabled: z.boolean(),
});
const template = z.object({ version: z.literal(1), categories: z.array(item).max(1500), rules: z.array(rule).max(1500) });
export type PortableTemplate = z.infer<typeof template>;
export type TemplatePreview = { token: string; categories: number; rules: number; conflicts: string[] };

export function portableTemplate(db: Db): PortableTemplate {
  const list = categories(db).filter((entry) => !entry.archived);
  const keys = new Map(list.map((entry, index) => [entry.id, 'category-' + (index + 1)]));
  return {
    version: 1,
    categories: list.map((entry) => ({
      key: keys.get(entry.id)!, parent: entry.parentId ? keys.get(entry.parentId) ?? null : null,
      name: entry.name, kind: entry.kind, colour: entry.colour, icon: entry.icon, sort: entry.sort, excludeReports: entry.excludeReports,
    })),
    rules: listRules(db).filter((entry) => keys.has(entry.categoryId) && !entry.conditions.accountId).map((entry) => ({
      name: entry.name, category: keys.get(entry.categoryId)!, conditions: entry.conditions, priority: entry.priority, enabled: entry.enabled,
    })),
  };
}

function parseTemplate(raw: string): PortableTemplate {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new UserError('Choose a valid iCash template JSON file.'); }
  const candidate = template.safeParse(parsed);
  if (!candidate.success) throw new UserError('This category template contains invalid or unsupported fields.');
  const entries = new Map(candidate.data.categories.map((entry) => [entry.key, entry]));
  if (entries.size !== candidate.data.categories.length) throw new UserError('Template category keys must be unique.');
  for (const row of candidate.data.categories) {
    if (row.parent) {
      const parent = entries.get(row.parent);
      if (!parent || parent.parent || parent.kind !== row.kind) throw new UserError('The template contains an invalid category parent.');
    }
  }
  const groups = new Set(candidate.data.categories.map((entry) => entry.parent));
  const legacyTargets = new Map<string, string>();
  for (const row of candidate.data.rules) {
    const target = entries.get(row.category);
    if (!target || groups.has(target.key) || row.conditions.accountId) {
      throw new UserError('The template contains a non-portable rule or invalid target.');
    }
    if (target.parent === null) {
      // Version-one templates could target a standalone category directly.
      let key = legacyTargets.get(target.key);
      if (!key) {
        key = randomUUID();
        legacyTargets.set(target.key, key);
        candidate.data.categories.push({ ...target, key, parent: target.key, name: 'General' });
      }
      row.category = key;
    }
  }
  return candidate.data;
}

function apply(db: Db, data: PortableTemplate) {
  const keys = new Map<string, string>();
  let added = 0;
  let rules = 0;
  const conflicts: string[] = [];
  for (const row of [...data.categories].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent)))) {
    const parentId = row.parent ? keys.get(row.parent) : null;
    if (row.parent && !parentId) {
      conflicts.push(row.name + ' was skipped because its parent was skipped.');
      continue;
    }
    const existing = categories(db).find((current) => !current.archived && current.parentId === parentId &&
      current.name.toLowerCase() === row.name.toLowerCase());
    if (existing) {
      if (existing.kind === row.kind) keys.set(row.key, existing.id);
      conflicts.push(row.name + ' already exists. Its settings are kept.');
      continue;
    }
    try {
      const result = saveCategory(db, { ...row, parentId: parentId ?? null, archived: false });
      const match = result.find((current) => !current.archived && current.parentId === parentId && current.name === row.name);
      if (match) { keys.set(row.key, match.id); added++; }
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      conflicts.push(row.name + ' was skipped. ' + error.message);
    }
  }
  for (const row of data.rules) {
    const categoryId = keys.get(row.category);
    if (!categoryId || listRules(db).some((current) => current.name === row.name && current.categoryId === categoryId)) {
      conflicts.push(row.name + ' rule was skipped because it already exists or its category could not be imported.');
      continue;
    }
    try { saveRule(db, { ...row, categoryId }); rules++; }
    catch (error) {
      if (!(error instanceof UserError)) throw error;
      conflicts.push(row.name + ' rule was skipped. ' + error.message);
    }
  }
  return { categories: added, rules, conflicts };
}

export class Templates {
  private pending?: { token: string; profile: string; data: PortableTemplate; result: Omit<TemplatePreview, 'token'> };
  clear() { this.pending = undefined; }

  preview(db: Db, profile: string, json: string) {
    const data = parseTemplate(json);
    const token = randomUUID();
    let result: Omit<TemplatePreview, 'token'> | undefined;
    const marker = new Error('Rollback template preview');
    try {
      db.transaction(() => { result = apply(db, data); throw marker; })();
    } catch (error) { if (error !== marker) throw error; }
    if (!result) throw new Error('Template preview did not complete.');
    this.pending = { token, profile, data, result };
    return { token, ...result };
  }

  commit(db: Db, profile: string, token: string) {
    const pending = this.pending;
    if (!pending || pending.profile !== profile || pending.token !== token) throw new UserError('Preview the template again.');
    const result = db.transaction(() => {
      const result = apply(db, pending.data);
      if (JSON.stringify(result) !== JSON.stringify(pending.result)) throw new UserError('The categories changed. Preview the template again.');
      return result;
    })();
    this.clear();
    return { token, ...result };
  }
}
