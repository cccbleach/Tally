-- mode: fk-off
-- 账户域下线：删除 accounts 表与三张子表上的账户归属，流水只挂账本（ledger_id）。
--
-- 产品决策：这 App 只做记账（收入/支出 + 分类 + 统计 + 周期账单 + 共享账本）。
-- 账户维度在生产中零使用——部署前只读预检实测：**只有 1 个账户**（初始余额 0），
-- 全部 1618 笔流水都挂在它上面；**0 条 type='transfer' 流水、0 条 transfer_to_account_id**；
-- import_items 2105 行里 account_id 非空的 0 条；recurring 0 行。
-- 因此「多账户/转账/账户余额」整套概念连同库表一起移除：
-- 流水归属账本（ledger_id 保留），类型只剩 收入/支出。
--
-- ⚠️ DROP TABLE + 删列不可逆：执行前必须先做部署前备份（pre- 备份，见 docs/production-deploy.md）。
-- 回滚 = 还原备份 + 代码回滚；只回滚代码不够（旧代码会读写 account_id 与 accounts 表）。
--
-- 为什么三张表都要重建：transactions.account_id（NOT NULL FK）、recurring.account_id（FK）、
-- import_items.account_id（FK）的建表 DDL 里都写着 REFERENCES accounts(id)，
-- 只 DROP TABLE accounts 会让迁移后的 PRAGMA foreign_key_check 失败（runner 的完整性门）。
-- SQLite 不能改 CHECK/FK，只能按 0016/0024 的既有模式「建新表 → 拷数据 → 改名 → 重建索引」。
--
-- ⚠️ 守门（天然）：transactions 重建时 CHECK 从 type IN ('income','expense','transfer')
-- 收紧为 ('income','expense')。若历史上真有转账流水（本次预检为 0），拷贝阶段会报
-- CHECK constraint failed 并整体回滚（不写半个字节、不记迁移）。出现时先人工核查：
--   SELECT id, date, amount, note FROM transactions WHERE type = 'transfer';
-- 确认处理方式后再启动（不要修改本迁移文件，内容已被 hash 锁定）。
--
-- 索引变化：transactions 丢掉 idx_tx_user_account（账户维度没了），
-- 其余 6 个索引（含 ledger 作用域的 uniq_tx_client_request 离线幂等索引）逐字保留。
-- dedup_key / external_id 不含账户维度，软硬去重语义均不受影响。

-- ---------- 1) transactions：删 account_id / transfer_to_account_id，CHECK 收紧 ----------
CREATE TABLE transactions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ledger_id TEXT REFERENCES ledgers(id) ON DELETE RESTRICT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT,
  date TEXT NOT NULL,
  recurring_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  external_id TEXT,
  source_type TEXT,
  dedup_key TEXT,
  linked_transaction_id TEXT,
  client_request_id TEXT
);
INSERT INTO transactions_new (id, user_id, ledger_id, category_id, type, amount, note, date, recurring_id, created_at, updated_at, external_id, source_type, dedup_key, linked_transaction_id, client_request_id)
  SELECT id, user_id, ledger_id, category_id, type, amount, note, date, recurring_id, created_at, updated_at, external_id, source_type, dedup_key, linked_transaction_id, client_request_id FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
CREATE INDEX idx_tx_user_date ON transactions(user_id, date);
CREATE INDEX idx_tx_ledger ON transactions(ledger_id);
CREATE UNIQUE INDEX uniq_recurring_tx ON transactions(recurring_id, date);
CREATE UNIQUE INDEX uniq_tx_external_source ON transactions(ledger_id, source_type, external_id);
CREATE INDEX idx_tx_dedup ON transactions(ledger_id, dedup_key);
CREATE UNIQUE INDEX uniq_tx_client_request
  ON transactions(ledger_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- ---------- 2) recurring：删 account_id ----------
CREATE TABLE recurring_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ledger_id TEXT REFERENCES ledgers(id) ON DELETE RESTRICT,
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
INSERT INTO recurring_new (id, user_id, ledger_id, category_id, type, amount, note, frequency, "interval", start_date, end_date, next_run_date, last_generated_date, is_active, created_at, updated_at)
  SELECT id, user_id, ledger_id, category_id, type, amount, note, frequency, "interval", start_date, end_date, next_run_date, last_generated_date, is_active, created_at, updated_at FROM recurring;
DROP TABLE recurring;
ALTER TABLE recurring_new RENAME TO recurring;
CREATE INDEX idx_recurring_user ON recurring(user_id);
CREATE INDEX idx_recurring_ledger ON recurring(ledger_id);

-- ---------- 3) import_items：删 account_id ----------
CREATE TABLE import_items_new (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  external_id TEXT,
  occurred_at TEXT NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
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
INSERT INTO import_items_new (id, job_id, category_id, external_id, occurred_at, type, amount, merchant, raw_description, dedup_key, source, duplicate_status, duplicate_score, matched_transaction_id, decision, error_code, created_at)
  SELECT id, job_id, category_id, external_id, occurred_at, type, amount, merchant, raw_description, dedup_key, source, duplicate_status, duplicate_score, matched_transaction_id, decision, error_code, created_at FROM import_items;
DROP TABLE import_items;
ALTER TABLE import_items_new RENAME TO import_items;
CREATE INDEX idx_import_items_job ON import_items(job_id);

-- ---------- 4) accounts 表下线（索引随表消失） ----------
DROP TABLE IF EXISTS accounts;
