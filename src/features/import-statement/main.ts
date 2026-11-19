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
import { mapping as mappingSchema, type AuditRow, type Batch, type Candidate, type FilePreview, type ImportPreview, type ImportReviewRow, type ImportReviewPage, type ImportResult, type Mapping, type RowPreview, type commitInput, type decodeInput } from './contract';
import type { AiRule, CategoryChoice } from '../openai/contract';
import { patternKey, resolveCategoryChoice, rulePattern, saveApprovedRules } from '../openai/main';
import { statementLimit } from './contract';
import { matchKey, normalizeRow, suggestFormats, suggestMapping } from './domain';

const reviewSize = 30;
const rowLimit = 60000;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

type ParsedRow = { original: string[]; row: number };
type PreparedRow = RowPreview & { matchedId?: string; matchedRow?: number };
type Session = {
  profileId: string; accountId: string; fileName: string; hash: string; bytes: Buffer;
  preview?: { version: string; mapping: Mapping; rows: PreparedRow[]; ledgerVersion: number; review?: { rows: Map<number, ImportReviewRow>; suggested: number; notice?: string } };
};
type Existing = Candidate & { id: string };
type DuplicateMatch = { balance: number | null; matchedId?: string; matchedRow?: number };
type SeenTransactions = { first: DuplicateMatch; byBalance: Map<number, DuplicateMatch>; withoutBalance?: DuplicateMatch };

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
      if (!stats.isFile() || stats.size === 0 || stats.size > statementLimit) {
        throw new UserError('Choose a CSV statement between 1 byte and 12 MiB.');
      }
      bytes = Buffer.alloc(stats.size + 1);
      const read = await handle.read(bytes, { offset: 0, length: bytes.length, position: 0 });
      if (read.bytesRead !== stats.size) throw new UserError('The statement changed while being read. Select it again.');
      bytes = bytes.subarray(0, read.bytesRead);
    } finally { await handle.close(); }
    if (!db.open) throw new UserError('The active profile changed. Select the statement again.');
    return this.selectBytes(db, profileId, accountId, basename(file), bytes);
  }

  selectBytes(db: Db, profileId: string, accountId: string, fileName: string, data: Uint8Array): FilePreview {
    if (!db.prepare('SELECT id FROM accounts WHERE id=? AND archived=0').get(accountId)) {
      throw new UserError('Choose an active account.');
    }
    if (!data.byteLength || data.byteLength > statementLimit) throw new UserError('Choose a statement up to 12 MiB.');
    const bytes = Buffer.from(data);
    const session = { profileId, accountId, fileName, hash: hash(bytes), bytes };
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
    if (!choice) return { token, fileName: session.fileName, delimiter: ',', encoding, header: 1, headers: [], rows: [], suggested: {}, saved };
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
    const headers = records[input.header - 1]?.original ?? [];
    const columns = suggestMapping(headers);
    const headerKey = headers.map(normalizeText).join('\u001f');
    const sample = records.slice(input.header).map(({ original }) => original)
      .filter((row) => row.map(normalizeText).join('\u001f') !== headerKey);
    return {
      ...input, fileName: session.fileName, rows: shown, headers,
      suggested: { ...columns, ...suggestFormats(sample, columns) },
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
    if (db.prepare(`
      SELECT 1 FROM import_batches b JOIN transactions t ON t.batch_id=b.id
      WHERE b.file_hash=? AND b.account_id<>? LIMIT 1
    `).get(session.hash, session.accountId)) {
      throw new UserError('This statement has already been imported into another account. Select the original account.');
    }
    const priorRows = db.prepare(`
      SELECT row_number AS row, transaction_id AS id FROM import_rows r JOIN import_batches b ON b.id=r.batch_id
      WHERE b.account_id=? AND b.file_hash=? AND r.state IN ('accepted','duplicate')
    `).all(session.accountId, session.hash) as { row: number; id: string | null }[];
    const prior = new Map(priorRows.map((row) => [row.row, row.id] as const));
    const existing = db.prepare(`
      SELECT id,date,description,amount,balance,reference FROM transactions WHERE account_id=? ORDER BY date,id
    `).all(session.accountId) as Existing[];
    const seen = new Map<string, SeenTransactions>();
    const remember = (key: string, match: DuplicateMatch) => {
      let group = seen.get(key);
      if (!group) {
        group = { first: match, byBalance: new Map() };
        seen.set(key, group);
      }
      if (match.balance === null) group.withoutBalance ??= match;
      else if (!group.byBalance.has(match.balance)) group.byBalance.set(match.balance, match);
    };
    for (const row of existing) remember(matchKey(row), { balance: row.balance, matchedId: row.id });
    const headerKey = header.map(normalizeText).join('\u001f');
    return records.map(({ original, row }, index): PreparedRow => {
      const result = { row, original };
      if (index < mapping.header || original.every((value) => !value.trim()) ||
          original.map(normalizeText).join('\u001f') === headerKey) {
        return { ...result, state: 'skipped', message: 'Header, preamble, or blank row.' };
      }
      const alreadyHandled = prior.has(row);
      let candidate: Candidate | undefined;
      try { candidate = normalizeRow(original, mapping); }
      catch (error) {
        if (!alreadyHandled) return { ...result, state: 'rejected', message: (error as Error).message };
      }
      if (alreadyHandled) {
        return { ...result, candidate, state: 'duplicate', message: 'Already handled in this file.', matchedId: prior.get(row) ?? undefined };
      }
      if (!candidate) throw new Error('An import row did not produce a transaction.');
      const key = matchKey(candidate);
      const group = seen.get(key);
      // Prefer a confirmed balance match. Missing balances make otherwise identical transactions indistinguishable.
      const match = candidate.balance === null ? group?.first : group?.byBalance.get(candidate.balance) ?? group?.withoutBalance;
      if (match) {
        const message = candidate.balance === null || match.balance === null
          ? 'Possible duplicate skipped. A running balance is needed to distinguish these transactions.'
          : match.matchedRow !== undefined
            ? 'Duplicate transaction in this statement.'
            : 'Already in this account with the same running balance.';
        return { ...result, candidate, state: 'duplicate', message, matchedId: match.matchedId, matchedRow: match.matchedRow };
      }
      remember(key, { balance: candidate.balance, matchedRow: row });
      return { ...result, candidate, state: 'accepted', message: '' };
    });
  }

  preview(db: Db, profileId: string, token: string, mapping: Mapping): ImportPreview {
    const session = this.get(profileId, token);
    const rows = this.prepare(db, session, mapping);
    const version = randomUUID();
    session.preview = { version, mapping, rows, ledgerVersion: this.ledgerVersion };
    const counts = { accepted: 0, duplicate: 0, rejected: 0, skipped: 0 };
    let debits = 0;
    let credits = 0;
    for (const row of rows) {
      counts[row.state]++;
      if (!row.candidate || row.state !== 'accepted') continue;
      if (row.candidate.amount < 0) debits = cents(debits + row.candidate.amount);
      else credits = cents(credits + row.candidate.amount);
    }
    const candidateRows = rows.flatMap((row) => row.candidate && row.matchedRow === undefined ? [row.candidate] : []);
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
    const present = ({ row, original, candidate, state, message }: PreparedRow): RowPreview =>
      ({ row, original, candidate, state, message });
    return {
      version, counts, debits, credits, net: cents(debits + credits), reconciliation,
      rows: rows.filter((row) => row.state !== 'skipped').slice(0, 60).map(present),
    };
  }

  private currentPreview(profileId: string, token: string, version: string) {
    const session = this.get(profileId, token);
    const preview = session.preview;
    if (!preview || preview.version !== version || preview.ledgerVersion !== this.ledgerVersion) {
      throw new UserError('This import preview is stale. Validate it again.');
    }
    return { session, preview };
  }

  uncategorized(db: Db, profileId: string, token: string, version: string): ImportReviewRow[] {
    const { session, preview } = this.currentPreview(profileId, token, version);
    const classify = categorizer(db);
    return preview.rows.flatMap(({ state, candidate, row }) => {
      if (state !== 'accepted' || !candidate) return [];
      const { categoryId, treatment } = classify({ ...candidate, accountId: session.accountId, merchant: '' });
      if (categoryId || treatment === 'transfer') return [];
      return [{ row, description: candidate.description, date: candidate.date, amount: candidate.amount, treatment }];
    });
  }

  setReview(profileId: string, token: string, version: string, rows: ImportReviewRow[], rules: AiRule[], notice?: string) {
    const { preview } = this.currentPreview(profileId, token, version);
    const byPattern = new Map(rules.map((rule) => [patternKey(rule), rule.category]));
    let suggested = 0;
    const reviewed = new Map(rows.map((row) => {
      const pattern = rulePattern(row);
      const suggestion = pattern ? byPattern.get(patternKey(pattern)) : undefined;
      if (suggestion) suggested++;
      return [row.row, { ...row, suggestion }];
    }));
    preview.review = { rows: reviewed, suggested, notice };
    return this.reviewPage(profileId, token, version, 0);
  }

  reviewPage(profileId: string, token: string, version: string, page: number): ImportReviewPage {
    const { preview } = this.currentPreview(profileId, token, version);
    if (!preview.review) throw new UserError('Validate the statement to review categories.');
    const { rows, suggested, notice } = preview.review;
    return { rows: [...rows.values()].slice(page * reviewSize, (page + 1) * reviewSize),
      total: rows.size, suggested, page, size: reviewSize, notice };
  }

  errors(profileId: string, token: string) {
    const preview = this.get(profileId, token).preview;
    if (!preview) throw new UserError('Validate the statement first.');
    return preview.rows.filter((row) => row.state === 'rejected').map((row) => [row.row, row.message, ...row.original]);
  }

  commit(db: Db, profileId: string, input: z.infer<typeof commitInput>) {
    const { session, preview } = this.currentPreview(profileId, input.token, input.version);
    const result = db.transaction((): ImportResult => {
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
        row.state !== preview.rows[index]?.state || row.matchedId !== preview.rows[index]?.matchedId ||
          row.matchedRow !== preview.rows[index]?.matchedRow)) {
        throw new UserError('The ledger changed after preview. Validate the statement again.');
      }
      if (rows.some((row) => row.state === 'rejected') && !input.acceptRejected) throw new UserError('Confirm that rejected rows should be left out.');
      db.prepare('INSERT INTO import_batches VALUES(?,?,?,?,?,?,?)').run(counts.id, session.accountId,
        session.fileName, session.hash, mappingHash, new Date().toISOString(), Number(!rows.some((row) => row.state === 'rejected')));
      const classify = categorizer(db);
      const reviewed = preview.review?.rows;
      const changes = new Map<number, CategoryChoice>(input.review?.changes.map(({ row, choice }) => [row, choice]));
      for (const row of changes.keys()) {
        if (!reviewed?.has(row)) throw new UserError('Only uncategorized transactions can be updated during import.');
      }
      const resolved = new Map<string, string | null>();
      const ruleApprovals = new Map<string, { pattern: NonNullable<ReturnType<typeof rulePattern>>; categories: Set<string | null> }>();
      const insert = db.prepare(`INSERT INTO transactions(id,account_id,batch_id,date,amount,description,normalized,balance,reference,
          treatment,category_id,classification,rule_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const audit = db.prepare('INSERT INTO import_rows VALUES(?,?,?,?,?,?)');
      const insertedByRow = new Map<number, string>();
      for (const { state, ...row } of rows) {
        let transactionId = row.matchedId ??
          (row.matchedRow === undefined ? null : insertedByRow.get(row.matchedRow) ?? null);
        if (state === 'accepted' && row.candidate) {
          const candidate = row.candidate;
          const classification = classify({ ...candidate, accountId: session.accountId, merchant: '' });
          const reviewedRow = input.review && reviewed?.get(row.row);
          let selected = classification.categoryId;
          if (reviewedRow) {
            if (classification.categoryId || classification.treatment !== reviewedRow.treatment) {
              throw new UserError('Categorization rules changed after validation. Validate the statement again.');
            }
            const choice = changes.get(row.row) ?? (reviewedRow.suggestion ? 'suggested' : '');
            const key = JSON.stringify([choice, reviewedRow.treatment, choice === 'suggested' ? reviewedRow.suggestion : undefined]);
            if (!resolved.has(key)) resolved.set(key, resolveCategoryChoice(db, choice, reviewedRow.treatment, reviewedRow.suggestion));
            selected = resolved.get(key) ?? null;
            const pattern = input.review?.saveRules ? rulePattern(reviewedRow) : null;
            if (pattern) {
              const key = patternKey(pattern);
              const approval = ruleApprovals.get(key) ?? { pattern, categories: new Set<string | null>() };
              approval.categories.add(selected);
              ruleApprovals.set(key, approval);
            }
          }
          transactionId = randomUUID();
          insert.run(transactionId, session.accountId, counts.id, candidate.date, candidate.amount, candidate.description,
            normalizeText(candidate.description), candidate.balance, candidate.reference, classification.treatment,
            selected, reviewedRow && selected ? 'manual' : classification.classification, classification.ruleId);
          insertedByRow.set(row.row, transactionId);
          counts.inserted++;
        }
        if (state === 'rejected') counts.rejected++;
        if (state === 'duplicate') counts.duplicate++;
        audit.run(counts.id, row.row, state, row.message, JSON.stringify(row.original), transactionId);
      }
      const approvals = [...ruleApprovals.values()].flatMap(({ pattern, categories }) => {
        const [id] = categories;
        return categories.size === 1 && id ? [{ pattern, categoryId: id }] : [];
      });
      const rulesSaved = approvals.length ? saveApprovedRules(db, approvals).size : 0;
      db.prepare('UPDATE accounts SET mapping=? WHERE id=?').run(JSON.stringify(preview.mapping), session.accountId);
      return rulesSaved ? { ...counts, rulesSaved } : counts;
    }).immediate();
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
