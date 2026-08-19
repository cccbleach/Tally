-- 数据层兜底约束：type 枚举、amount > 0（应用层已有校验，这里是纵深防御）
-- SQLite 不支持给已有表加 CHECK，通过“重建表”实现，并保留外键与原索引。
-- 说明：本迁移在 runner 的单个事务内执行，因此不再使用 BEGIN/COMMIT。

CREATE TABLE transactions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ledger_id TEXT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transfer')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  note TEXT,
  date TEXT NOT NULL,
  transfer_to_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  recurring_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO transactions_new (id, user_id, ledger_id, account_id, category_id, type, amount, currency, note, date, transfer_to_account_id, recurring_id, created_at, updated_at)
  SELECT id, user_id, ledger_id, account_id, category_id, type, amount, currency, note, date, transfer_to_account_id, recurring_id, created_at, updated_at FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX idx_tx_user_date ON transactions(user_id, date);
CREATE INDEX idx_tx_user_account ON transactions(user_id, account_id);
CREATE INDEX idx_tx_ledger ON transactions(ledger_id);
CREATE UNIQUE INDEX uniq_recurring_tx ON transactions(recurring_id, date);
