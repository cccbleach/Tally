-- 账本概念：为每个用户建立默认账本，并把既有数据归属到默认账本。
-- 后续可扩展为多账本（选择 ledger_id 即可）。

CREATE TABLE ledgers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_ledgers_user ON ledgers(user_id);

ALTER TABLE users ADD COLUMN default_ledger_id TEXT;

ALTER TABLE accounts ADD COLUMN ledger_id TEXT;
ALTER TABLE categories ADD COLUMN ledger_id TEXT;
ALTER TABLE transactions ADD COLUMN ledger_id TEXT;
ALTER TABLE budgets ADD COLUMN ledger_id TEXT;
ALTER TABLE recurring ADD COLUMN ledger_id TEXT;

CREATE INDEX idx_accounts_ledger ON accounts(ledger_id);
CREATE INDEX idx_categories_ledger ON categories(ledger_id);
CREATE INDEX idx_tx_ledger ON transactions(ledger_id);
CREATE INDEX idx_budgets_ledger ON budgets(ledger_id);
CREATE INDEX idx_recurring_ledger ON recurring(ledger_id);

-- 为既有用户建立默认账本并回填
INSERT INTO ledgers (id, user_id, name, currency, is_default, created_at, updated_at)
SELECT lower(hex(randomblob(16))), id, '默认账本', 'CNY', 1, datetime('now'), datetime('now')
FROM users;

UPDATE users
SET default_ledger_id = (SELECT l.id FROM ledgers l WHERE l.user_id = users.id AND l.is_default = 1);

UPDATE accounts
SET ledger_id = (SELECT u.default_ledger_id FROM users u WHERE u.id = accounts.user_id)
WHERE ledger_id IS NULL;

UPDATE categories
SET ledger_id = (SELECT u.default_ledger_id FROM users u WHERE u.id = categories.user_id)
WHERE ledger_id IS NULL;

UPDATE transactions
SET ledger_id = (SELECT u.default_ledger_id FROM users u WHERE u.id = transactions.user_id)
WHERE ledger_id IS NULL;

UPDATE budgets
SET ledger_id = (SELECT u.default_ledger_id FROM users u WHERE u.id = budgets.user_id)
WHERE ledger_id IS NULL;

UPDATE recurring
SET ledger_id = (SELECT u.default_ledger_id FROM users u WHERE u.id = recurring.user_id)
WHERE ledger_id IS NULL;
