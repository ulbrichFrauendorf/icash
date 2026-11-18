import Database from 'better-sqlite3-multiple-ciphers';
import { migrations } from './migrations';

export type Db = Database.Database;

export function openDatabase(path: string, key: Buffer, existing = true): Db {
  if (key.length !== 32) throw new Error('Invalid database key.');
  const db = new Database(path, { fileMustExist: existing });
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma('legacy = 4');
    db.pragma(`key = '${key.toString('hex')}'`);
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = DELETE');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function schemaVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }));
}

export function migrate(db: Db): void {
  const version = schemaVersion(db);
  if (version > migrations.length) throw new Error('This profile requires a newer version of iCash.');
  db.transaction(() => {
    for (const [index, migration] of migrations.entries()) {
      if (index < version) continue;
      db.exec(migration);
      db.pragma(`user_version = ${index + 1}`);
    }
  })();
}

export function checkIntegrity(db: Db): void {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' ||
      (db.pragma('foreign_key_check') as unknown[]).length) {
    throw new Error('The profile database did not pass its integrity check.');
  }
}
