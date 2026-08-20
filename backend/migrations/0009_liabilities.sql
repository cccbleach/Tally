-- 车贷/房贷等贷款 + 信用卡账单
CREATE TABLE loans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ledger_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other', -- car | mortgage | other
  principal INTEGER NOT NULL,         -- 分
  annual_rate REAL NOT NULL DEFAULT 0,
  term_months INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  monthly_payment INTEGER NOT NULL DEFAULT 0,
  remaining_principal INTEGER NOT NULL,
  account_id TEXT,
  next_payment_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_loans_ledger ON loans(ledger_id);

CREATE TABLE loan_payments (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  principal_part INTEGER NOT NULL,
  interest_part INTEGER NOT NULL,
  total INTEGER NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_loan_payments_loan ON loan_payments(loan_id);

ALTER TABLE accounts ADD COLUMN credit_limit INTEGER;
ALTER TABLE accounts ADD COLUMN billing_day INTEGER;
ALTER TABLE accounts ADD COLUMN repayment_day INTEGER;

CREATE TABLE credit_card_bills (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  period TEXT NOT NULL, -- YYYY-MM
  statement_balance INTEGER NOT NULL,
  minimum_payment INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  paid INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_cc_bills_account ON credit_card_bills(account_id);
