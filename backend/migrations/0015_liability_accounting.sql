-- 里程碑五：贷款/信用卡会计闭环。
-- 1) transactions 增加 payment_group_id：一次贷款还款会拆成「本金转账」+「利息支出」两条流水，
--    用同一分组关联，保证可追溯（本金不计入消费支出、利息计入支出）。
ALTER TABLE transactions ADD COLUMN payment_group_id TEXT;

-- 2) loans 增加币种、负债账户、还款方式、状态。
ALTER TABLE loans ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY';
ALTER TABLE loans ADD COLUMN liability_account_id TEXT;
ALTER TABLE loans ADD COLUMN repayment_method TEXT NOT NULL DEFAULT 'equal_installment';
ALTER TABLE loans ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- 3) 重建 loan_payments：期次号 + 应还/已还本金利息 + 还款流水关联 + 状态，且 (loan_id, installment_no) 唯一。
--    旧表字段 (scheduled_date, principal_part, interest_part, total, paid) 迁入新结构。
CREATE TABLE loan_payments_new (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL,
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
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | paid
  UNIQUE (loan_id, installment_no)
);

-- 老数据迁移：按原还款日期（同日期按 rowid）排序补上期次号；已还期次把本金/利息记入已还。
INSERT INTO loan_payments_new
  (id, loan_id, installment_no, due_date, principal_due, interest_due, principal_paid, interest_paid, total, paid, paid_at, payment_transaction_id, status)
SELECT
  lp.id,
  lp.loan_id,
  (SELECT COUNT(*) FROM loan_payments lp2
     WHERE lp2.loan_id = lp.loan_id
       AND (lp2.scheduled_date < lp.scheduled_date
            OR (lp2.scheduled_date = lp.scheduled_date AND lp2.rowid < lp.rowid))) + 1,
  lp.scheduled_date,
  lp.principal_part,
  lp.interest_part,
  CASE WHEN lp.paid = 1 THEN lp.principal_part ELSE 0 END,
  CASE WHEN lp.paid = 1 THEN lp.interest_part ELSE 0 END,
  lp.total,
  lp.paid,
  NULL,
  NULL,
  CASE WHEN lp.paid = 1 THEN 'paid' ELSE 'pending' END
FROM loan_payments lp;

DROP TABLE loan_payments;
ALTER TABLE loan_payments_new RENAME TO loan_payments;

CREATE INDEX idx_loan_payments_loan ON loan_payments(loan_id);
