-- mode: fk-off
-- 里程碑八：外键与实际声明 + 事务加固（阶段 11）。
-- SQLite 无法对已有表 ALTER TABLE ADD FOREIGN KEY，因此重建需要加外键的表。
-- 领域选择：
--   历史财务数据（accounts/categories/transactions/budgets/recurring/loans/credit_card_bills/
--   loan_payments/import_jobs）→ ON DELETE RESTRICT，避免财务数据被级联静默删除；
--   暂存导入明细 import_items.job_id → ON DELETE CASCADE（任务删除时清理明细）；
--   家庭成员 family_invitations → ON DELETE CASCADE。
-- 保持既有外键行为（user_id CASCADE、category_id SET NULL、transfer_to CASCADE 等）不变，
-- 仅补上缺失的 ledger_id / account_id / loan_id / job_id 外键。

-- ---------- 1) accounts ----------
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  currency TEXT NOT NULL DEFAULT 'CNY',
  initial_balance INTEGER NOT NULL DEFAULT 0,
  icon TEXT,
  color TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ledger_id TEXT REFERENCES ledgers(id) ON DELETE RESTRICT,
  credit_limit INTEGER,
  billing_day INTEGER,
  repayment_day INTEGER
);
INSERT INTO accounts_new (id, user_id, name, type, currency, initial_balance, icon, color, is_archived, created_at, ledger_id, credit_limit, billing_day, repayment_day)
  SELECT id, user_id, name, type, currency, initial_balance, icon, color, is_archived, created_at, ledger_id, credit_limit, billing_day, repayment_day FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
CREATE INDEX idx_accounts_ledger ON accounts(ledger_id);
CREATE INDEX idx_accounts_user ON accounts(user_id);

-- ---------- 2) categories ----------
CREATE TABLE categories_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ledger_id TEXT REFERENCES ledgers(id) ON DELETE RESTRICT
);
INSERT INTO categories_new (id, user_id, name, type, icon, color, sort_order, created_at, ledger_id)
  SELECT id, user_id, name, type, icon, color, sort_order, created_at, ledger_id FROM categories;
DROP TABLE categories;
ALTER TABLE categories_new RENAME TO categories;
CREATE INDEX idx_categories_ledger ON categories(ledger_id);
CREATE INDEX idx_categories_user ON categories(user_id);

-- ---------- 3) transactions ----------
CREATE TABLE transactions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ledger_id TEXT REFERENCES ledgers(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  note TEXT,
  date TEXT NOT NULL,
  transfer_to_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  recurring_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  external_id TEXT,
  source_type TEXT,
  dedup_key TEXT,
  linked_transaction_id TEXT,
  payment_group_id TEXT
);
INSERT INTO transactions_new (id, user_id, ledger_id, account_id, category_id, type, amount, currency, note, date, transfer_to_account_id, recurring_id, created_at, updated_at, external_id, source_type, dedup_key, linked_transaction_id, payment_group_id)
  SELECT id, user_id, ledger_id, account_id, category_id, type, amount, currency, note, date, transfer_to_account_id, recurring_id, created_at, updated_at, external_id, source_type, dedup_key, linked_transaction_id, payment_group_id FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
CREATE INDEX idx_tx_user_date ON transactions(user_id, date);
CREATE INDEX idx_tx_user_account ON transactions(user_id, account_id);
CREATE INDEX idx_tx_ledger ON transactions(ledger_id);
CREATE UNIQUE INDEX uniq_recurring_tx ON transactions(recurring_id, date);
CREATE UNIQUE INDEX uniq_tx_external_source ON transactions(ledger_id, source_type, external_id);
CREATE INDEX idx_tx_dedup ON transactions(ledger_id, dedup_key);

-- ---------- 4) budgets ----------
CREATE TABLE budgets_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ledger_id TEXT REFERENCES ledgers(id) ON DELETE RESTRICT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO budgets_new (id, user_id, ledger_id, year, month, category_id, amount, created_at, updated_at)
  SELECT id, user_id, ledger_id, year, month, category_id, amount, created_at, updated_at FROM budgets;
DROP TABLE budgets;
ALTER TABLE budgets_new RENAME TO budgets;
CREATE INDEX idx_budgets_ledger ON budgets(ledger_id);
CREATE INDEX idx_budgets_user ON budgets(user_id, year, month);
CREATE UNIQUE INDEX uniq_budget_total ON budgets(user_id, year, month) WHERE category_id IS NULL;
CREATE UNIQUE INDEX uniq_budget_cat ON budgets(user_id, year, month, category_id) WHERE category_id IS NOT NULL;

-- ---------- 5) recurring ----------
CREATE TABLE recurring_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ledger_id TEXT REFERENCES ledgers(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT,
  frequency TEXT NOT NULL,
  "interval" INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,
  end_date TEXT,
  next_run_date TEXT NOT NULL,
  last_generated_date TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO recurring_new (id, user_id, ledger_id, account_id, category_id, type, amount, note, frequency, "interval", start_date, end_date, next_run_date, last_generated_date, is_active, created_at, updated_at)
  SELECT id, user_id, ledger_id, account_id, category_id, type, amount, note, frequency, "interval", start_date, end_date, next_run_date, last_generated_date, is_active, created_at, updated_at FROM recurring;
DROP TABLE recurring;
ALTER TABLE recurring_new RENAME TO recurring;
CREATE INDEX idx_recurring_ledger ON recurring(ledger_id);
CREATE INDEX idx_recurring_user ON recurring(user_id);

-- ---------- 6) credit_card_bills ----------
CREATE TABLE credit_card_bills_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  period TEXT NOT NULL,
  statement_balance INTEGER NOT NULL CHECK (statement_balance >= 0),
  minimum_payment INTEGER NOT NULL DEFAULT 0 CHECK (minimum_payment >= 0),
  due_date TEXT,
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  UNIQUE (account_id, period)
);
INSERT INTO credit_card_bills_new (id, account_id, period, statement_balance, minimum_payment, due_date, paid)
  SELECT id, account_id, period, statement_balance, minimum_payment, due_date, paid FROM credit_card_bills;
DROP TABLE credit_card_bills;
ALTER TABLE credit_card_bills_new RENAME TO credit_card_bills;
CREATE INDEX idx_cc_bills_account ON credit_card_bills(account_id);

-- ---------- 7) loan_payments ----------
CREATE TABLE loan_payments_new (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
  installment_no INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  principal_due INTEGER NOT NULL CHECK (principal_due >= 0),
  interest_due INTEGER NOT NULL CHECK (interest_due >= 0),
  principal_paid INTEGER NOT NULL DEFAULT 0 CHECK (principal_paid >= 0),
  interest_paid INTEGER NOT NULL DEFAULT 0 CHECK (interest_paid >= 0),
  total INTEGER NOT NULL CHECK (total >= 0),
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  paid_at TEXT,
  payment_transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  UNIQUE (loan_id, installment_no)
);
INSERT INTO loan_payments_new (id, loan_id, installment_no, due_date, principal_due, interest_due, principal_paid, interest_paid, total, paid, paid_at, payment_transaction_id, status)
  SELECT id, loan_id, installment_no, due_date, principal_due, interest_due, principal_paid, interest_paid, total, paid, paid_at, payment_transaction_id, status FROM loan_payments;
DROP TABLE loan_payments;
ALTER TABLE loan_payments_new RENAME TO loan_payments;
CREATE INDEX idx_loan_payments_loan ON loan_payments(loan_id);

-- ---------- 8) loans ----------
CREATE TABLE loans_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ledger_id TEXT REFERENCES ledgers(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  principal INTEGER NOT NULL,
  annual_rate REAL NOT NULL DEFAULT 0,
  term_months INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  monthly_payment INTEGER NOT NULL DEFAULT 0,
  remaining_principal INTEGER NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  next_payment_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  liability_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  repayment_method TEXT NOT NULL DEFAULT 'equal_installment',
  status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO loans_new (id, user_id, ledger_id, name, type, principal, annual_rate, term_months, start_date, monthly_payment, remaining_principal, account_id, next_payment_date, created_at, updated_at, currency, liability_account_id, repayment_method, status)
  SELECT id, user_id, ledger_id, name, type, principal, annual_rate, term_months, start_date, monthly_payment, remaining_principal, account_id, next_payment_date, created_at, updated_at, currency, liability_account_id, repayment_method, status FROM loans;
DROP TABLE loans;
ALTER TABLE loans_new RENAME TO loans;
CREATE INDEX idx_loans_ledger ON loans(ledger_id);

-- ---------- 9) import_jobs ----------
CREATE TABLE import_jobs_new (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  filename TEXT,
  file_hash TEXT,
  status TEXT NOT NULL DEFAULT 'staged',
  total_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO import_jobs_new (id, ledger_id, user_id, source, filename, file_hash, status, total_count, imported_count, skipped_count, created_at, updated_at)
  SELECT id, ledger_id, user_id, source, filename, file_hash, status, total_count, imported_count, skipped_count, created_at, updated_at FROM import_jobs;
DROP TABLE import_jobs;
ALTER TABLE import_jobs_new RENAME TO import_jobs;
CREATE INDEX idx_import_jobs_ledger ON import_jobs(ledger_id);

-- ---------- 10) import_items (台账明细：任务删除时级联清掉) ----------
CREATE TABLE import_items_new (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  external_id TEXT,
  occurred_at TEXT NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  merchant TEXT,
  raw_description TEXT,
  dedup_key TEXT,
  source TEXT,
  duplicate_status TEXT NOT NULL DEFAULT 'new',
  duplicate_score INTEGER NOT NULL DEFAULT 0,
  matched_transaction_id TEXT,
  decision TEXT NOT NULL DEFAULT 'accept',
  error_code TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO import_items_new (id, job_id, account_id, category_id, external_id, occurred_at, type, amount, currency, merchant, raw_description, dedup_key, source, duplicate_status, duplicate_score, matched_transaction_id, decision, error_code, created_at)
  SELECT id, job_id, account_id, category_id, external_id, occurred_at, type, amount, currency, merchant, raw_description, dedup_key, source, duplicate_status, duplicate_score, matched_transaction_id, decision, error_code, created_at FROM import_items;
DROP TABLE import_items;
ALTER TABLE import_items_new RENAME TO import_items;
CREATE INDEX idx_import_items_job ON import_items(job_id);
