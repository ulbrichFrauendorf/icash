import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Db } from '../../platform/main/database';
import { UserError } from '../../shared/schema';
import type { Account, saveAccountInput } from './contract';

export function accounts(db: Db): Account[] {
  return db.prepare('SELECT id,name,kind,archived FROM accounts ORDER BY archived,name,id').all() as Account[];
}

export function saveAccount(db: Db, input: z.infer<typeof saveAccountInput>): Account[] {
  if (db.prepare('SELECT id FROM accounts WHERE name=? AND id<>?').get(input.name, input.id ?? '')) {
    throw new UserError('An account already uses this name.');
  }
  if (input.id) {
    if (!db.prepare('UPDATE accounts SET name=?,kind=?,archived=? WHERE id=?')
      .run(input.name, input.kind, Number(input.archived), input.id).changes) {
      throw new UserError('Account could not be found.');
    }
  } else {
    db.prepare('INSERT INTO accounts(id,name,kind,archived) VALUES(?,?,?,?)')
      .run(randomUUID(), input.name, input.kind, Number(input.archived));
  }
  return accounts(db);
}
