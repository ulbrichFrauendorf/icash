import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { parse } from 'csv-parse/sync';
import type { z } from 'zod';
import type { Db } from '../../platform/main/database';
import { cents, normalizeText } from '../../shared/finance';
import { UserError } from '../../shared/schema';
import { categorizer } from '../categorization/main';
import { mapping as mappingSchema, type AuditRow, type Batch, type Candidate, type FilePreview, type ImportPreview, type Mapping, type RowPreview, type commitInput, type decodeInput } from './contract';
import { matchKey, normalizeRow, suggestMapping } from './domain';

const fileLimit = 12 * 1024 * 1024;
const rowLimit = 60000;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

type ParsedRow = { original: string[]; row: number };
type PreparedRow = RowPreview & { matchedId?: string; possibleIds?: string[] };
type Session = {
  profileId: string; accountId: string; fileName: string; hash: string; bytes: Buffer;
  preview?: { version: string; mapping: Mapping; rows: PreparedRow[]; ledgerVersion: number };
};
type Existing = Candidate & { id: string };

function parseFile(bytes: Buffer, format: Pick<Mapping, 'delimiter' | 'encoding'>, preview = false): ParsedRow[] {
  try {
    const text = new TextDecoder(format.encoding, { fatal: true }).decode(bytes);
    if (text.includes('\u0000')) throw new Error('Unexpected null character.');
    const records = parse(text, {
      bom: true, delimiter: format.delimiter, relax_column_count: true, info: true,
      max_record_size: 16384, to: preview ? 60 : rowLimit + 1,
    }) as unknown as { record: string[]; info: { lines: number } }[];
    if (records.length > rowLimit) throw new UserError('The statement exceeds the 60,000-row limit.');
    let row = 1;
    return records.map(({ record, info }) => {
      if (record.length > 128) throw new UserError('The statement exceeds the 128-column limit.');
      const result = { original: record, row };
      row = info.lines + 1;
      return result;
    });
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError('The statement could not be parsed. Check the encoding, delimiter, quotes, and row lengths.');
  }
}

export class Imports {
  private session?: Session;
  private token?: string;

  clear() { this.session = undefined; this.token = undefined; }

  private get(profileId: string, token: string) {
    if (!this.session || token !== this.token || this.session.profileId !== profileId) {
      throw new UserError('This preview has expired. Select the statement again.');
    }
    return this.session;
  }

  async select(db: Db, profileId: string, accountId: string, file: string): Promise<FilePreview> {
    if (!db.prepare('SELECT id FROM accounts WHERE id=? AND archived=0').get(accountId)) {
      throw new UserError('Choose an active account.');
    }
    const handle = await open(file, 'r');
    let bytes: Buffer;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size === 0 || stats.size > fileLimit) {
        throw new UserError('Choose a CSV statement between 1 byte and 12 MiB.');
      }
      bytes = Buffer.alloc(stats.size + 1);
      const read = await handle.read(bytes, { offset: 0, length: bytes.length, position: 0 });
      if (read.bytesRead !== stats.size) throw new UserError('The statement changed while being read. Select it again.');
      bytes = bytes.subarray(0, read.bytesRead);
    } finally { await handle.close(); }
    if (!db.open) throw new UserError('The active profile changed. Select the statement again.');
    const session = { profileId, accountId, fileName: basename(file), hash: hash(bytes), bytes };
    this.session = session;
    const token = this.token = randomUUID();
    const saved = this.saved(db, accountId);
    const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' :
      saved?.encoding ?? (isUtf8(bytes) ? 'utf-8' : 'windows-1252');
    const options = ([',', ';', '\t'] as const).flatMap((delimiter) => {
      try {
        const rows = parseFile(bytes, { delimiter, encoding }, true);
        const index = rows.findIndex((entry) => {
          const { date, description } = suggestMapping(entry.original);
          return date !== undefined && description !== undefined;
        });
        return [{ delimiter, index, width: Math.max(0, ...rows.slice(0, 50).map((row) => row.original.length)) }];
      } catch { return []; }
    }).sort((a, b) => Number(b.index >= 0) - Number(a.index >= 0) || b.width - a.width);
    const choice = options[0];
    if (!choice) return { token, fileName: session.fileName, delimiter: ',', encoding, header: 1, rows: [], suggested: {}, saved };
    return this.decode(db, profileId, { token, encoding, delimiter: choice.delimiter, header: choice.index >= 0 && choice.index < 50 ? choice.index + 1 : 1 });
  }

  cancel(profileId: string, token: string) {
    this.get(profileId, token);
    this.clear();
  }

  private saved(db: Db, accountId: string): Mapping | null {
    const row = db.prepare('SELECT mapping FROM accounts WHERE id=?').get(accountId) as { mapping: string | null } | undefined;
    if (!row?.mapping) return null;
    const checked = mappingSchema.safeParse(JSON.parse(row.mapping));
    return checked.success ? checked.data : null;
  }

  decode(db: Db, profileId: string, input: z.infer<typeof decodeInput>): FilePreview {
    const session = this.get(profileId, input.token);
    session.preview = undefined;
    const records = parseFile(session.bytes, input, true);
    const shown = records.slice(Math.max(0, input.header - 4), input.header + 5).map((row) => row.original);
    const header = records[input.header - 1]?.original ?? [];
    return {
      ...input, fileName: session.fileName, rows: shown, suggested: suggestMapping(header),
      saved: this.saved(db, session.accountId),
    };
  }

  private ledgerVersion = 0;

  private prepare(db: Db, session: Session, mapping: Mapping): PreparedRow[] {
    const records = parseFile(session.bytes, mapping);
    const header = records[mapping.header - 1]?.original;
    if (!header) throw new UserError('The selected header row does not exist.');
    if ([mapping.date,mapping.description,mapping.amount,mapping.debit,mapping.credit,mapping.balance,mapping.reference]
      .some((column) => column !== undefined && column >= header.length)) throw new UserError('A mapped column is missing from the header.');
    const priorRows = db.prepare(`
      SELECT row_number AS row, transaction_id AS id FROM import_rows r JOIN import_batches b ON b.id=r.batch_id
      WHERE b.account_id=? AND b.file_hash=? AND r.state IN ('accepted','duplicate')
    `).all(session.accountId, session.hash) as { row: number; id: string | null }[];
    const prior = new Map(priorRows.map((row) => [row.row, row.id] as const));
    const existing = db.prepare(`
      SELECT id,date,description,amount,balance,reference FROM transactions WHERE account_id=? ORDER BY date,id
    `).all(session.accountId) as Existing[];
    const reserved = new Set(priorRows.flatMap(({ id }) => id ? [id] : []));
    const byKey = new Map<string, Existing[]>();
    const strongMatches = new Map<string, Existing | null>();
    const strongKey = (key: string, row: Candidate, includeReference: boolean) =>
      JSON.stringify([key, row.balance, includeReference, includeReference ? row.reference : null]);
    for (const row of existing) {
      if (reserved.has(row.id)) continue;
      const key = matchKey(row);
      const list = byKey.get(key) ?? [];
      list.push(row);
      byKey.set(key, list);
      if (row.balance === null) continue;
      for (const exact of [false, true]) {
        const identity = strongKey(key, row, exact);
        strongMatches.set(identity, strongMatches.has(identity) ? null : row);
      }
    }
    const headerKey = header.map(normalizeText).join('\u001f');
    const prepared = records.map(({ original, row }, index): PreparedRow => {
      const result = { row, original };
      if (index < mapping.header || original.every((value) => !value.trim()) ||
          original.map(normalizeText).join('\u001f') === headerKey) {
        return { ...result, state: 'skipped', message: 'Header, preamble, or blank row.' };
      }
      if (prior.has(row)) return { ...result, state: 'duplicate', message: 'Already handled in this file.', matchedId: prior.get(row) ?? undefined };
      let candidate: Candidate;
      try { candidate = normalizeRow(original, mapping); }
      catch (error) { return { ...result, state: 'rejected', message: (error as Error).message }; }
      const strong = candidate.amount && candidate.balance !== null
        ? strongMatches.get(strongKey(matchKey(candidate), candidate, Boolean(candidate.reference))) : null;
      if (strong && !reserved.has(strong.id)) {
        reserved.add(strong.id);
        return { ...result, candidate, state: 'duplicate', message: 'Matched amount, description, date, and running balance.', matchedId: strong.id };
      }
      return { ...result, candidate, state: 'accepted', message: '' };
    });
    const comparisons = new Map([...byKey.entries()].map(([key, entries]) => {
      const available = entries.filter((row) => !reserved.has(row.id));
      return [key, {
        possibleIds: available.map((row) => row.id),
        matches: available.slice(0, 3).map(({ date, description, amount, balance, reference }) => ({ date, description, amount, balance, reference })),
      }] as const;
    }));
    return prepared.map((row) => {
      if (row.state !== 'accepted' || !row.candidate) return row;
      const comparison = comparisons.get(matchKey(row.candidate));
      if (!comparison?.possibleIds.length) return row;
      return { ...row, ...comparison, state: 'review', message: 'Possible overlap. Compare existing entries before choosing.' };
    });
  }

  preview(db: Db, profileId: string, token: string, mapping: Mapping): ImportPreview {
    const session = this.get(profileId, token);
    const rows = this.prepare(db, session, mapping);
    const version = randomUUID();
    session.preview = { version, mapping, rows, ledgerVersion: this.ledgerVersion };
    const counts = { accepted: 0, duplicate: 0, rejected: 0, skipped: 0, review: 0 };
    let debits = 0;
    let credits = 0;
    for (const row of rows) {
      counts[row.state]++;
      if (!row.candidate || (row.state !== 'accepted' && row.state !== 'review')) continue;
      if (row.candidate.amount < 0) debits = cents(debits + row.candidate.amount);
      else credits = cents(credits + row.candidate.amount);
    }
    const candidateRows = rows.flatMap((row) => row.candidate ? [row.candidate] : []);
    const comparable = candidateRows.slice(1).filter((row, index) => row.balance !== null && candidateRows[index]?.balance !== null);
    const forward = candidateRows.slice(1).every((row, index) => {
      const prior = candidateRows[index];
      return !prior || row.balance === null || prior.balance === null || row.balance - prior.balance === row.amount;
    });
    const reverse = candidateRows.slice(1).every((row, index) => {
      const prior = candidateRows[index];
      return !prior || row.balance === null || prior.balance === null || prior.balance - row.balance === prior.amount;
    });
    const reconciliation = comparable.length && !forward && !reverse ? 'Running balances do not reconcile. Verify mapping and statement continuity.' : null;
    const present = ({ row, original, candidate, state, message, matches }: PreparedRow): RowPreview =>
      ({ row, original, candidate, state, message, matches });
    return {
      version, counts, debits, credits, net: cents(debits + credits), reconciliation,
      rows: rows.filter((row) => row.state !== 'skipped').slice(0, 60).map(present),
      review: rows.filter((row) => row.state === 'review').map(present),
    };
  }

  errors(profileId: string, token: string) {
    const preview = this.get(profileId, token).preview;
    if (!preview) throw new UserError('Validate the statement first.');
    return preview.rows.filter((row) => row.state === 'rejected').map((row) => [row.row, row.message, ...row.original]);
  }

  commit(db: Db, profileId: string, input: z.infer<typeof commitInput>) {
    const session = this.get(profileId, input.token);
    const preview = session.preview;
    if (!preview || input.version !== preview.version || preview.ledgerVersion !== this.ledgerVersion) {
      throw new UserError('This import preview is stale. Validate it again.');
    }
    const result = db.transaction(() => {
      if (!db.prepare('SELECT id FROM accounts WHERE id=? AND archived=0').get(session.accountId)) {
        throw new UserError('The selected account is no longer active.');
      }
      const mappingHash = hash(JSON.stringify(preview.mapping));
      const prior = db.prepare('SELECT id FROM import_batches WHERE account_id=? AND file_hash=? AND mapping_hash=? AND complete=1')
        .get(session.accountId, session.hash, mappingHash) as { id: string } | undefined;
      if (prior) return { id: prior.id, inserted: 0, duplicate: preview.rows.filter((row) => row.state === 'duplicate').length, rejected: 0 };
      const counts = { id: randomUUID(), inserted: 0, duplicate: 0, rejected: 0 };
      const rows = this.prepare(db, session, preview.mapping);
      if (rows.length !== preview.rows.length || rows.some((row, index) =>
        row.state !== preview.rows[index]?.state || row.matchedId !== preview.rows[index]?.matchedId)) {
        throw new UserError('The ledger changed after preview. Validate the statement again.');
      }
      if (rows.some((row) => row.state === 'rejected') && !input.acceptRejected) throw new UserError('Confirm that rejected rows should be left out.');
      if (rows.some((row) => row.state === 'review' && !input.decisions[row.row])) throw new UserError('Review all possible duplicates.');
      db.prepare('INSERT INTO import_batches VALUES(?,?,?,?,?,?,?)').run(counts.id, session.accountId,
        session.fileName, session.hash, mappingHash, new Date().toISOString(), Number(!rows.some((row) => row.state === 'rejected')));
      const classify = categorizer(db);
      const insert = db.prepare(`INSERT INTO transactions(id,account_id,batch_id,date,amount,description,normalized,balance,reference,
          treatment,category_id,classification,rule_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const audit = db.prepare('INSERT INTO import_rows VALUES(?,?,?,?,?,?)');
      const claimed = new Map<string[], number>();
      for (const row of rows) {
        const state = row.state === 'review' ? input.decisions[row.row] === 'keep' ? 'accepted' : 'duplicate' : row.state;
        let transactionId = row.matchedId ?? null;
        if (state === 'duplicate' && row.state === 'review') {
          const ids = row.possibleIds ?? [];
          const index = claimed.get(ids) ?? 0;
          const match = ids[index];
          if (!match) throw new UserError('More rows were skipped than matching ledger entries. Keep the additional transactions.');
          claimed.set(ids, index + 1);
          transactionId = match;
        }
        if (state === 'accepted' && row.candidate) {
          const candidate = row.candidate;
          const classification = classify({ ...candidate, accountId: session.accountId, merchant: '' });
          transactionId = randomUUID();
          insert.run(transactionId, session.accountId, counts.id, candidate.date, candidate.amount, candidate.description,
            normalizeText(candidate.description), candidate.balance, candidate.reference, classification.treatment,
            classification.categoryId, classification.classification, classification.ruleId);
          counts.inserted++;
        }
        if (state === 'rejected') counts.rejected++;
        if (state === 'duplicate') counts.duplicate++;
        audit.run(counts.id, row.row, state, row.message, JSON.stringify(row.original), transactionId);
      }
      db.prepare('UPDATE accounts SET mapping=? WHERE id=?').run(JSON.stringify(preview.mapping), session.accountId);
      return counts;
    })();
    this.ledgerVersion++;
    this.clear();
    return result;
  }
}

export function batches(db: Db): Batch[] {
  return db.prepare(`SELECT b.id,a.name AS account,b.file_name AS file,b.created_at AS createdAt,
    sum(CASE WHEN r.state='accepted' THEN 1 ELSE 0 END) AS inserted,
    sum(CASE WHEN r.state='duplicate' THEN 1 ELSE 0 END) AS duplicate,
    sum(CASE WHEN r.state='rejected' THEN 1 ELSE 0 END) AS rejected,
    sum(CASE WHEN r.state='skipped' THEN 1 ELSE 0 END) AS skipped
    FROM import_batches b JOIN accounts a ON a.id=b.account_id LEFT JOIN import_rows r ON r.batch_id=b.id
    GROUP BY b.id ORDER BY b.created_at DESC,b.id`).all() as Batch[];
}

export function auditRows(db: Db, batchId: string, page: number): AuditRow[] {
  return (db.prepare(`SELECT row_number AS row,state,message,transaction_id AS transactionId,original FROM import_rows
    WHERE batch_id=? ORDER BY row_number LIMIT 100 OFFSET ?`).all(batchId, page * 100) as
    (Omit<AuditRow, 'original'> & { original: string })[]).map((row) => ({ ...row, original: JSON.parse(row.original) as string[] }));
}
