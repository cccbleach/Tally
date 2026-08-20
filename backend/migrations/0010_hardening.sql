-- 数据层约束加固（阶段 11）
-- 1) credit_card_bills：(account_id, period) 唯一，避免同一期重复账单；金额 CHECK。
-- 2) loan_payments：(loan_id, scheduled_date) 唯一，避免同一期次重复；金额 CHECK。
-- SQLite 通过“重建表”补 CHECK/UNIQUE，并在同一迁移内保留数据与索引。

-- credit_card_bills：先清理同一 (account_id, period) 的重复项（保留最新一条），再建唯一约束
CREATE TABLE credit_card_bills_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  period TEXT NOT NULL,
  statement_balance INTEGER NOT NULL CHECK (statement_balance >= 0),
  minimum_payment INTEGER NOT NULL DEFAULT 0 CHECK (minimum_payment >= 0),
  due_date TEXT,
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  UNIQUE (account_id, period)
);

INSERT INTO credit_card_bills_new (id, account_id, period, statement_balance, minimum_payment, due_date, paid)
  SELECT id, account_id, period, statement_balance, minimum_payment, due_date, paid
  FROM credit_card_bills
  WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id, period ORDER BY rowid DESC) AS rn
      FROM credit_card_bills
    ) WHERE rn = 1
  );

DROP TABLE credit_card_bills;
ALTER TABLE credit_card_bills_new RENAME TO credit_card_bills;

CREATE INDEX idx_cc_bills_account ON credit_card_bills(account_id);

-- loan_payments：同一贷款同一期次唯一；金额非负
CREATE TABLE loan_payments_new (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  principal_part INTEGER NOT NULL CHECK (principal_part >= 0),
  interest_part INTEGER NOT NULL CHECK (interest_part >= 0),
  total INTEGER NOT NULL CHECK (total >= 0),
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  UNIQUE (loan_id, scheduled_date)
);

INSERT INTO loan_payments_new (id, loan_id, scheduled_date, principal_part, interest_part, total, paid)
  SELECT id, loan_id, scheduled_date, principal_part, interest_part, total, paid
  FROM loan_payments;

DROP TABLE loan_payments;
ALTER TABLE loan_payments_new RENAME TO loan_payments;

CREATE INDEX idx_loan_payments_loan ON loan_payments(loan_id);
