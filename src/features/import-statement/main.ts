import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { parse } from 'csv-parse/sync';
import type { z } from 'zod';
import type { Db } from '../../platform/main/database';
import { cents, normalizeText } from '../../shared/finance';
import { UserError } from '../../shared/schema';
import { categories } from '../categories/main';
import { defaultGroup } from '../categories/template';
import { categorizer } from '../categorization/main';
import { mapping as mappingSchema, type AuditRow, type Batch, type Candidate, type FilePreview, type ImportPreview, type ImportReviewRow, type CategoryProposal, type ImportModeration, type ImportRule, type ResumableImport, type ImportResult, type Mapping, type RowPreview, type commitInput, type decodeInput, type moderateCategoryInput, type importRulesInput } from './contract';
import type { CategoryChoice } from '../openai/contract';
import { patternKey, resolveCategoryChoice, reviewSample, rulePattern, saveApprovedRules, type ReviewSuggestion } from '../openai/main';
import { statementLimit } from './contract';
import { matchKey, normalizeRow, suggestFormats, suggestMapping } from './domain';

const rowLimit = 60000;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

type ParsedRow = { original: string[]; row: number };
type PreparedRow = RowPreview & { matchedId?: string; matchedRow?: number };
type ReviewPattern = NonNullable<ReturnType<typeof rulePattern>>;
type ModeratedCategory = CategoryProposal & { categoryId?: string };
type Review = {
  rows: Map<number, ImportReviewRow>;
  patterns: Map<number, ReviewPattern>;
  proposals: Map<string, ModeratedCategory>;
  rowProposals: Map<number, string>;
  notice?: string;
};
type Session = {
  profileId: string; accountId: string; fileName: string; hash: string; bytes: Buffer;
  file?: FilePreview;
  preview?: { summary: ImportPreview; mapping: Mapping; rows: PreparedRow[]; ledgerVersion: number; review?: Review };
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
    return session.file = {
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
    const summary = {
      version, counts, debits, credits, net: cents(debits + credits), reconciliation,
      rows: rows.filter((row) => row.state !== 'skipped').slice(0, 60).map(present),
    };
    session.preview = { summary, mapping, rows, ledgerVersion: this.ledgerVersion };
    return summary;
  }

  private currentPreview(profileId: string, token: string, version: string) {
    const session = this.get(profileId, token);
    const preview = session.preview;
    if (!preview || preview.summary.version !== version || preview.ledgerVersion !== this.ledgerVersion) {
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

  setReview(db: Db, profileId: string, token: string, version: string, rows: ImportReviewRow[],
    suggestions: ReadonlyMap<string, ReviewSuggestion>, notice?: string): ImportPreview {
    const { preview } = this.currentPreview(profileId, token, version);
    const review: Review = { rows: new Map(), patterns: new Map(), proposals: new Map(), rowProposals: new Map(), notice };
    const byName = new Map<string, ModeratedCategory>();
    for (const row of rows) {
      const sample = reviewSample(row);
      const suggestion = suggestions.get(sample.key);
      const pattern = suggestion ? suggestion.rule : sample.pattern;
      if (pattern) review.patterns.set(row.row, pattern);
      review.rows.set(row.row, { ...row, suggestion: suggestion?.category });
      if (!suggestion || suggestion.category.id) continue;
      const { name, group = defaultGroup(row.treatment, name) } = suggestion.category;
      const key = JSON.stringify([normalizeText(group), normalizeText(name)]);
      let proposal = byName.get(key);
      if (!proposal) {
        proposal = { id: randomUUID(), name, group, rows: 0, status: 'pending' };
        byName.set(key, proposal);
        review.proposals.set(proposal.id, proposal);
      }
      proposal.rows++;
      review.rowProposals.set(row.row, proposal.id);
    }
    preview.review = review;
    return this.reviewPreview(db, preview);
  }

  moderation(profileId: string): ImportModeration | null {
    const { session, token } = this;
    const preview = session?.preview;
    if (!token || session?.profileId !== profileId || !preview?.review?.proposals.size) return null;
    return { token, version: preview.summary.version, fileName: session.fileName,
      proposals: [...preview.review.proposals.values()].map(({ id, name, group, rows, status }) => ({ id, name, group, rows, status })) };
  }

  moderateCategory(db: Db, profileId: string, input: z.infer<typeof moderateCategoryInput>) {
    const { preview } = this.currentPreview(profileId, input.token, input.version);
    const proposal = preview.review?.proposals.get(input.proposalId);
    if (!proposal || proposal.status !== 'pending') throw new UserError('This category has already been reviewed.');
    if (input.action === 'edit') {
      if (!input.edit) throw new UserError('Enter a category name and group.');
      if (normalizeText(input.edit.name) === normalizeText(input.edit.group)) throw new UserError('Use different names for the category and group.');
      Object.assign(proposal, input.edit);
    } else if (input.action === 'accept') {
      const { name, group } = proposal;
      const id = db.transaction(() => resolveCategoryChoice(db, 'suggested', 'expense',
        { id: null, name, group, kind: 'expense', label: group + ' / ' + name })).immediate();
      if (!id) throw new UserError('Could not save this category.');
      proposal.categoryId = id;
      proposal.status = 'accepted';
    } else {
      proposal.status = 'deleted';
    }
    return this.moderation(profileId);
  }

  resume(db: Db, profileId: string): ResumableImport | null {
    const session = this.session;
    if (session?.profileId !== profileId || !session.file || !session.preview) return null;
    return { accountId: session.accountId, file: session.file, mapping: session.preview.mapping,
      preview: this.reviewPreview(db, session.preview) };
  }

  private reviewPreview(db: Db, preview: NonNullable<Session['preview']>): ImportPreview {
    const review = preview.review;
    if (!review) return preview.summary;
    const pendingCategories = [...review.proposals.values()].filter((proposal) => proposal.status === 'pending').length;
    if (pendingCategories) return { ...preview.summary, pendingCategories };
    const rows = this.reviewRows(db, review);
    return { ...preview.summary, review: {
      rows: [...rows.values()], suggested: [...rows.values()].filter((row) => row.suggestion).length, notice: review.notice,
    } };
  }

  private reviewRows(db: Db, review?: Review) {
    const rows = new Map<number, ImportReviewRow>();
    if (!review) return rows;
    if ([...review.proposals.values()].some((proposal) => proposal.status === 'pending')) {
      throw new UserError('Finish reviewing the proposed categories on the Categories page.');
    }
    const list = new Map(categories(db).map((category) => [category.id, category]));
    for (const [number, row] of review.rows) {
      const proposalId = review.rowProposals.get(number);
      const categoryId = proposalId ? review.proposals.get(proposalId)?.categoryId : row.suggestion?.id;
      const category = categoryId ? list.get(categoryId) : undefined;
      const parent = category?.parentId ? list.get(category.parentId) : undefined;
      const suggestion = category && parent && !category.archived && !parent.archived && category.kind === row.treatment
        ? { id: category.id, name: category.name, kind: row.treatment, label: parent.name + ' / ' + category.name }
        : undefined;
      rows.set(number, { ...row, suggestion });
    }
    return rows;
  }

  private selections(db: Db, rows: Map<number, ImportReviewRow>, choices: z.infer<typeof importRulesInput>['changes']) {
    const changes = new Map(choices.map(({ row, choice }) => [row, choice]));
    for (const row of changes.keys()) {
      if (!rows.has(row)) throw new UserError('Only uncategorized transactions can be updated during import.');
    }
    const resolved = new Map<string, string | null>();
    return new Map([...rows].map(([number, row]) => {
      const choice: CategoryChoice = changes.get(number) ?? row.suggestion?.id ?? '';
      if (choice === 'suggested') throw new UserError('Choose an approved category.');
      const key = JSON.stringify([choice, row.treatment]);
      if (!resolved.has(key)) resolved.set(key, resolveCategoryChoice(db, choice, row.treatment));
      return [number, resolved.get(key) ?? null];
    }));
  }

  private ruleAssignments(review: Review | undefined, selected: Map<number, string | null>) {
    const groups = new Map<string, { pattern: ReviewPattern; categories: Set<string | null>; rows: number[] }>();
    for (const [row, pattern] of review?.patterns ?? []) {
      const key = patternKey(pattern);
      const group = groups.get(key) ?? { pattern, categories: new Set<string | null>(), rows: [] };
      group.categories.add(selected.get(row) ?? null);
      group.rows.push(row);
      groups.set(key, group);
    }
    return [...groups].flatMap(([key, { pattern, categories, rows }]) => {
      const [categoryId] = categories;
      return categories.size === 1 && categoryId ? [{ key, pattern, categoryId, rows }] : [];
    });
  }

  reviewRules(db: Db, profileId: string, input: z.infer<typeof importRulesInput>): ImportRule[] {
    const { preview } = this.currentPreview(profileId, input.token, input.version);
    const selected = this.selections(db, this.reviewRows(db, preview.review), input.changes);
    const list = new Map(categories(db).map((category) => [category.id, category]));
    return this.ruleAssignments(preview.review, selected).map(({ key, pattern, categoryId, rows }) => {
      const category = list.get(categoryId)!;
      const parent = list.get(category.parentId!)!;
      return { key, name: pattern.name, match: pattern.match, direction: pattern.direction,
        category: parent.name + ' / ' + category.name, categoryId, rows, kind: category.kind as ImportReviewRow['treatment'] };
    });
  }

  errors(profileId: string, token: string) {
    const preview = this.get(profileId, token).preview;
    if (!preview) throw new UserError('Validate the statement first.');
    return preview.rows.filter((row) => row.state === 'rejected').map((row) => [row.row, row.message, ...row.original]);
  }

  commit(db: Db, profileId: string, input: z.infer<typeof commitInput>) {
    const { session, preview } = this.currentPreview(profileId, input.token, input.version);
    const reviewed = this.reviewRows(db, preview.review);
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
      const selectedCategories = input.review ? this.selections(db, reviewed, input.review.changes) : new Map<number, string | null>();
      const selectedRules = new Set(input.review?.ruleKeys);
      const approvals = selectedRules.size
        ? this.ruleAssignments(preview.review, selectedCategories).filter(({ key }) => selectedRules.has(key)) : [];
      if (approvals.length !== selectedRules.size) throw new UserError('Rule assignments changed. Review the rules again.');
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
          const reviewedRow = input.review && reviewed.get(row.row);
          let selected = classification.categoryId;
          if (reviewedRow) {
            if (classification.categoryId || classification.treatment !== reviewedRow.treatment) {
              throw new UserError('Categorization rules changed after validation. Validate the statement again.');
            }
            selected = selectedCategories.get(row.row) ?? null;
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

export function auditRows(db: Db, batchId: string): AuditRow[] {
  return (db.prepare(`SELECT row_number AS row,state,message,transaction_id AS transactionId,original FROM import_rows
    WHERE batch_id=? ORDER BY row_number`).all(batchId) as
    (Omit<AuditRow, 'original'> & { original: string })[]).map((row) => ({ ...row, original: JSON.parse(row.original) as string[] }));
}
