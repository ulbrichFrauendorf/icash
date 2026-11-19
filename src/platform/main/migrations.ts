// Append each new version after the existing versions. The array index defines the schema version.
import { upgradeCategoryGroups } from './category-upgrade';

export const migrations = [`
  CREATE TABLE profile (
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
    template_version INTEGER,
    theme TEXT NOT NULL DEFAULT 'light' CHECK(theme IN ('light', 'dark'))
  ) STRICT;
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('current','savings','credit-card','other')),
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
    mapping TEXT
  ) STRICT;
  CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
    template_key TEXT UNIQUE,
    name TEXT NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL CHECK(kind IN ('expense','income','transfer','savings')),
    colour TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
    exclude_reports INTEGER NOT NULL DEFAULT 0 CHECK(exclude_reports IN (0,1))
  ) STRICT;
  CREATE UNIQUE INDEX unique_category_name ON categories(ifnull(parent_id, ''), name COLLATE NOCASE)
    WHERE archived = 0;
  CREATE TABLE import_batches (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    file_name TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    mapping_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    complete INTEGER NOT NULL CHECK(complete IN (0,1))
  ) STRICT;
  CREATE INDEX batch_fingerprint ON import_batches(account_id, file_hash, mapping_hash, complete);
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    batch_id TEXT NOT NULL REFERENCES import_batches(id),
    date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    description TEXT NOT NULL,
    normalized TEXT NOT NULL,
    balance INTEGER,
    reference TEXT,
    merchant TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    treatment TEXT NOT NULL CHECK(treatment IN ('expense','income','transfer')),
    category_id TEXT REFERENCES categories(id),
    classification TEXT NOT NULL DEFAULT 'suggested' CHECK(classification IN ('suggested','rule','merchant','manual')),
    rule_id TEXT,
    exclude_budget INTEGER NOT NULL DEFAULT 0 CHECK(exclude_budget IN (0,1)),
    exclude_reports INTEGER NOT NULL DEFAULT 0 CHECK(exclude_reports IN (0,1))
  ) STRICT;
  CREATE INDEX txn_account_date ON transactions(account_id,date,id);
  CREATE INDEX txn_date ON transactions(date,id);
  CREATE INDEX txn_match ON transactions(account_id,date,amount,normalized);
  CREATE INDEX txn_ref ON transactions(account_id,reference);
  CREATE INDEX txn_category ON transactions(category_id);
  CREATE VIRTUAL TABLE transaction_search USING fts5(
    normalized, merchant, notes, tags, content='transactions', content_rowid='rowid', tokenize='trigram'
  );
  CREATE TRIGGER txn_search_insert AFTER INSERT ON transactions BEGIN
    INSERT INTO transaction_search(rowid,normalized,merchant,notes,tags)
    VALUES (new.rowid,new.normalized,new.merchant,new.notes,new.tags);
  END;
  CREATE TRIGGER txn_search_update AFTER UPDATE OF normalized,merchant,notes,tags ON transactions BEGIN
    INSERT INTO transaction_search(transaction_search,rowid,normalized,merchant,notes,tags)
    VALUES ('delete',old.rowid,old.normalized,old.merchant,old.notes,old.tags);
    INSERT INTO transaction_search(rowid,normalized,merchant,notes,tags)
    VALUES (new.rowid,new.normalized,new.merchant,new.notes,new.tags);
  END;
  CREATE TABLE import_rows (
    batch_id TEXT NOT NULL REFERENCES import_batches(id),
    row_number INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('accepted','duplicate','rejected','skipped')),
    message TEXT NOT NULL,
    original TEXT NOT NULL,
    transaction_id TEXT REFERENCES transactions(id),
    PRIMARY KEY(batch_id,row_number)
  ) STRICT;
  CREATE INDEX import_row_transaction ON import_rows(transaction_id);
  CREATE TABLE coverage (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    start TEXT NOT NULL,
    end TEXT NOT NULL CHECK(end >= start),
    PRIMARY KEY(account_id,start,end)
  ) STRICT;
  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category_id TEXT NOT NULL REFERENCES categories(id),
    conditions TEXT NOT NULL,
    priority INTEGER NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    source TEXT NOT NULL CHECK(source IN ('user','default')),
    template_key TEXT UNIQUE
  ) STRICT;
  CREATE TABLE merchant_mappings (
    merchant TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('debit','credit')),
    category_id TEXT NOT NULL REFERENCES categories(id),
    PRIMARY KEY(merchant,direction)
  ) STRICT;
  CREATE TABLE splits (
    transaction_id TEXT NOT NULL REFERENCES transactions(id),
    ordinal INTEGER NOT NULL,
    category_id TEXT NOT NULL REFERENCES categories(id),
    amount INTEGER NOT NULL,
    PRIMARY KEY(transaction_id,ordinal)
  ) STRICT;
  CREATE TABLE monthly_allocations (
    month TEXT NOT NULL,
    category_id TEXT NOT NULL REFERENCES categories(id),
    allocation INTEGER NOT NULL CHECK(allocation >= 0),
    rollover INTEGER NOT NULL CHECK(rollover IN (0,1)),
    PRIMARY KEY(month,category_id)
  ) STRICT;
  CREATE TABLE budget_defaults (
    effective TEXT NOT NULL,
    category_id TEXT NOT NULL REFERENCES categories(id),
    amount INTEGER CHECK(amount >= 0),
    cadence TEXT NOT NULL CHECK(cadence IN ('monthly','weekly','annual')),
    rollover INTEGER NOT NULL CHECK(rollover IN (0,1)),
    PRIMARY KEY(effective,category_id)
  ) STRICT;
  CREATE TABLE budget_revisions (
    month TEXT NOT NULL,
    revision INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(month,revision)
  ) STRICT;
  CREATE TABLE budget_status (
    month TEXT PRIMARY KEY,
    closed INTEGER NOT NULL CHECK(closed IN (0,1))
  ) STRICT;
  CREATE TABLE transfer_pairs (id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE transfer_legs (
    transaction_id TEXT PRIMARY KEY REFERENCES transactions(id),
    pair_id TEXT NOT NULL REFERENCES transfer_pairs(id) ON DELETE CASCADE,
    previous TEXT NOT NULL
  ) STRICT;
  CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    target INTEGER NOT NULL CHECK(target > 0),
    due TEXT
  ) STRICT;
  CREATE TABLE goal_entries (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id),
    pair_id TEXT UNIQUE REFERENCES transfer_pairs(id),
    amount INTEGER NOT NULL CHECK(amount <> 0),
    date TEXT NOT NULL
  ) STRICT;
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    cadence TEXT NOT NULL CHECK(cadence IN ('weekly','monthly')),
    next TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('confirmed','dismissed'))
  ) STRICT;
`, `
  ALTER TABLE profile ADD COLUMN pay_day INTEGER CHECK(pay_day BETWEEN 1 AND 31);
`, upgradeCategoryGroups] as const;
