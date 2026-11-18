import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { checkIntegrity, migrate, openDatabase } from '../../platform/main/database';
import { UserError } from '../../shared/schema';
import type { ProfileStore } from '../profiles/main';

const magic = Buffer.from('ICASH-B1');
const limit = 256 * 1024 * 1024;
const derive = (passphrase: string, salt: Buffer) => scryptSync(passphrase, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });

function readBounded(file: string) {
  if (statSync(file).size > limit) throw new UserError('This file exceeds the 256 MiB backup limit.');
  const bytes = readFileSync(file);
  if (bytes.length > limit) throw new UserError('This file exceeds the 256 MiB backup limit.');
  return bytes;
}

export function exportBackup(profiles: ProfileStore, destination: string, passphrase: string) {
  const { id, db } = profiles.active();
  checkIntegrity(db);
  // The app owns the sole connection and uses DELETE journaling. This synchronous read
  // runs between committed writes, so the on-disk encrypted file is a complete snapshot.
  const payload = readBounded(profiles.path(id, 'ledger.sqlite'));
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const header = Buffer.concat([magic, salt, nonce]);
  const wrappingKey = derive(passphrase, salt);
  const key = profiles.key(id);
  const temp = destination + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce).setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(key), cipher.update(payload), cipher.final()]);
    const backup = Buffer.concat([header, cipher.getAuthTag(), ciphertext]);
    if (backup.length > limit) throw new UserError('The backup exceeds the 256 MiB limit.');
    writeFileSync(temp, backup, { flag: 'wx', mode: 0o600 });
    renameSync(temp, destination);
  } finally {
    key.fill(0);
    wrappingKey.fill(0);
    rmSync(temp, { force: true });
  }
}

export function restoreBackup(profiles: ProfileStore, source: string, passphrase: string) {
  const bytes = readBounded(source);
  const header = bytes.subarray(0, 36);
  if (!bytes.subarray(0, 8).equals(magic) || bytes.length < 85) throw new UserError('Unsupported or incomplete iCash backup.');
  const wrappingKey = derive(passphrase, bytes.subarray(8, 24));
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, bytes.subarray(24, 36))
      .setAAD(header).setAuthTag(bytes.subarray(36, 52));
    plaintext = Buffer.concat([decipher.update(bytes.subarray(52)), decipher.final()]);
  } catch {
    throw new UserError('The backup passphrase is incorrect or the backup is damaged.');
  } finally { wrappingKey.fill(0); }
  const key = plaintext.subarray(0, 32);
  const replacement = randomBytes(32);
  try {
    const id = profiles.install(replacement, (file) => {
      writeFileSync(file, plaintext.subarray(32), { flag: 'wx', mode: 0o600 });
      const db = openDatabase(file, key);
      try {
        checkIntegrity(db);
        migrate(db);
        db.pragma(`rekey = '${replacement.toString('hex')}'`);
        return (db.prepare('SELECT name FROM profile').get() as { name: string }).name;
      } finally { db.close(); }
    });
    return profiles.select(id);
  } finally {
    plaintext.fill(0);
    replacement.fill(0);
  }
}
