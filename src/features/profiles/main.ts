import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, migrate, schemaVersion, type Db } from '../../platform/main/database';
import { migrations } from '../../platform/main/migrations';
import { id, UserError } from '../../shared/schema';
import { restoreDefaults } from '../categories/main';
import type { ActiveProfile, Profile, ProfileState } from './contract';

export interface KeyProtection {
  wrap(key: Buffer): Buffer;
  unwrap(wrapped: Buffer): Buffer;
}

export function householdPayDay(db: Db): number | null {
  return (db.prepare('SELECT pay_day AS payDay FROM profile').get() as { payDay: number | null } | undefined)?.payDay ?? null;
}

export class ProfileStore {
  private current?: { id: string; db: Db };
  private readonly root: string;
  constructor(root: string, private readonly protection: KeyProtection) {
    this.root = join(root, 'profiles');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  path(id: string, name: 'ledger.sqlite' | 'key' | 'profile.json' | 'before-upgrade.sqlite' | 'openai-key') {
    return join(this.root, id, name);
  }

  key(id: string) {
    return this.protection.unwrap(readFileSync(this.path(id, 'key')));
  }

  hasOpenAiKey(profileId: string) {
    return existsSync(this.path(profileId, 'openai-key'));
  }

  openAiKey(profileId: string): string {
    if (!this.hasOpenAiKey(profileId)) throw new UserError('Connect OpenAI in Settings before requesting suggestions.');
    const bytes = this.protection.unwrap(readFileSync(this.path(profileId, 'openai-key')));
    try { return bytes.toString('utf8'); }
    finally { bytes.fill(0); }
  }

  setOpenAiKey(profileId: string, key: string | null) {
    const file = this.path(profileId, 'openai-key');
    if (key === null) {
      rmSync(file, { force: true });
      return;
    }
    const temp = file + '.tmp';
    const bytes = Buffer.from(key, 'utf8');
    try {
      writeFileSync(temp, this.protection.wrap(bytes), { mode: 0o600 });
      renameSync(temp, file);
    } finally {
      bytes.fill(0);
      rmSync(temp, { force: true });
    }
  }

  private profiles(): Profile[] {
    return readdirSync(this.root, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || !id.safeParse(entry.name).success) return [];
      const path = this.path(entry.name, 'profile.json');
      if (!existsSync(path)) return [];
      const name: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return typeof name === 'string' ? [{ id: entry.name, name }] : [];
    }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  state(): ProfileState {
    const active = this.current
      ? this.current.db.prepare('SELECT name,theme,pay_day AS payDay FROM profile').get() as Omit<ActiveProfile, 'id'>
      : null;
    return { profiles: this.profiles(), active: active && this.current ? { id: this.current.id, ...active } : null };
  }

  active() {
    if (!this.current) throw new UserError('Select a household profile first.');
    return this.current;
  }

  autoSelect() {
    const marker = join(this.root, 'active');
    if (!existsSync(marker)) return;
    const saved = readFileSync(marker, 'utf8');
    if (this.profiles().some((profile) => profile.id === saved)) this.select(saved);
  }

  select(profileId: string): ProfileState {
    if (!this.profiles().some((profile) => profile.id === profileId)) throw new UserError('Profile was not found.');
    if (this.current?.id === profileId) return this.state();
    const key = this.key(profileId);
    let db: Db;
    try { db = openDatabase(this.path(profileId, 'ledger.sqlite'), key); }
    catch { throw new UserError('iCash could not unlock this profile. Try restoring an encrypted backup.'); }
    finally { key.fill(0); }
    try {
      if (schemaVersion(db) < migrations.length) {
        const target = this.path(profileId, 'before-upgrade.sqlite');
        writeFileSync(target, readFileSync(this.path(profileId, 'ledger.sqlite')), { mode: 0o600 });
      }
      migrate(db);
      const marker = join(this.root, 'active');
      writeFileSync(marker + '.tmp', profileId, { mode: 0o600 });
      renameSync(marker + '.tmp', marker);
    } catch (error) {
      db.close();
      throw error;
    }
    this.close();
    this.current = { id: profileId, db };
    return this.state();
  }

  create(name: string, seed: boolean): ProfileState {
    const key = randomBytes(32);
    try {
      const profileId = this.install(key, (file) => {
        const db = openDatabase(file, key, false);
        try {
          migrate(db);
          db.transaction(() => {
            db.prepare('INSERT INTO profile(name) VALUES(?)').run(name);
            if (seed) restoreDefaults(db);
          })();
        } finally { db.close(); }
        return name;
      });
      return this.select(profileId);
    } finally { key.fill(0); }
  }

  install(key: Buffer, writeDatabase: (file: string) => string): string {
    const profileId = randomUUID();
    const staging = join(this.root, '.' + profileId);
    mkdirSync(staging, { mode: 0o700 });
    try {
      writeFileSync(join(staging, 'key'), this.protection.wrap(key), { mode: 0o600 });
      const name = writeDatabase(join(staging, 'ledger.sqlite'));
      writeFileSync(join(staging, 'profile.json'), JSON.stringify(name), { mode: 0o600 });
      renameSync(staging, join(this.root, profileId));
      return profileId;
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }

  remove(profileId: string): ProfileState {
    if (this.active().id !== profileId) throw new UserError('Select the profile before deleting it.');
    this.close();
    const marker = join(this.root, 'active');
    rmSync(marker, { force: true });
    const staging = join(this.root, '.' + profileId + '.deleting');
    renameSync(join(this.root, profileId), staging);
    rmSync(staging, { recursive: true, force: true });
    return this.state();
  }

  close() {
    this.current?.db.close();
    this.current = undefined;
  }
}
