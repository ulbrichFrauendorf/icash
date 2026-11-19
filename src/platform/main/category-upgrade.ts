import { randomUUID } from 'node:crypto';
import { defaultGroup, householdTemplate } from '../../features/categories/template';
import type { Db } from './database';

const references = ['transactions', 'splits', 'rules', 'merchant_mappings', 'monthly_allocations', 'budget_defaults'] as const;

export function upgradeCategoryGroups(db: Db) {
  const roots = db.prepare('SELECT id, name, kind, colour, archived FROM categories WHERE parent_id IS NULL').all() as
    { id: string; name: string; kind: string; colour: string; archived: number }[];
  const find = db.prepare('SELECT id,kind FROM categories WHERE parent_id IS ? AND name=? AND archived=0');
  const insert = db.prepare('INSERT INTO categories(id,parent_id,name,kind,colour,archived) VALUES(?,?,?,?,?,?)');
  for (const root of roots) {
    const linked = db.prepare("SELECT 1 FROM transfer_legs WHERE json_extract(previous,'$.category_id')=? LIMIT 1").get(root.id);
    if (!linked && !references.some((table) => db.prepare(`SELECT 1 FROM ${table} WHERE category_id=? LIMIT 1`).get(root.id))) continue;
    const group = defaultGroup(root.kind, root.name);
    const parent = find.get(null, group) as { id: string; kind: string } | undefined;
    const isGroup = householdTemplate.some(([, label]) => label.toLowerCase() === root.name.toLowerCase()) ||
      db.prepare('SELECT 1 FROM categories WHERE parent_id=?').get(root.id);
    if (!isGroup && (!parent || (parent.kind === root.kind && !find.get(parent.id, root.name)))) {
      const parentId = parent?.id ?? randomUUID();
      if (!parent) insert.run(parentId, null, group, root.kind, root.colour, 0);
      db.prepare('UPDATE categories SET parent_id=? WHERE id=?').run(parentId, root.id);
    } else {
      // Keep the group and isolate its historical assignments from its other children.
      let label = 'General';
      for (let suffix = 2; find.get(root.id, label); suffix++) label = 'General ' + suffix;
      const childId = randomUUID();
      insert.run(childId, root.id, label, root.kind, root.colour, root.archived);
      db.prepare("UPDATE transfer_legs SET previous=json_set(previous,'$.category_id',?) WHERE json_extract(previous,'$.category_id')=?")
        .run(childId, root.id);
      for (const table of references) db.prepare(`UPDATE ${table} SET category_id=? WHERE category_id=?`).run(childId, root.id);
    }
  }
  for (const table of references) {
    for (const [event, clause] of [['insert', 'INSERT'], ['update', 'UPDATE OF category_id']]) {
      db.exec(`CREATE TRIGGER ${table}_category_${event} BEFORE ${clause} ON ${table}
        WHEN EXISTS (SELECT 1 FROM categories WHERE id=NEW.category_id AND parent_id IS NULL)
        BEGIN SELECT RAISE(ABORT, 'Choose a category within a group.'); END`);
    }
  }
  db.exec('UPDATE profile SET pay_day=25 WHERE pay_day IS NULL');
}
