-- mode: fk-off
-- 补回 transactions 丢失的 CHECK 约束（数据完整性防线）。
--
-- 背景：0005 给 transactions 加了
--   CHECK (type IN ('income','expense','transfer')) 与 CHECK (amount > 0)；
-- 0016 为补 ledger_id / account_id 外键第二次重建该表时漏抄了这两条，之后 21 个迁移都没补回，
-- 实际库里已无任何 CHECK（排查 0005/0016 时用 .schema transactions 实测确认）。
-- 于是「金额必须为正、类型必须合法」只剩应用层 zod 一道防线：任何绕过 API 的写入
-- （脚本、人工 SQL、未来的新代码路径）都能落进 0 元或非法类型的流水。
--
-- 这是第三次重建，列/外键/索引与当前现状（含 0023 新增的 client_request_id 与部分唯一索引）
-- 完全一致，只多两条 CHECK。SQLite 不支持 ALTER TABLE ADD CONSTRAINT，只能重建。
--
-- ⚠️ 若库中已存在**其他**违反约束的历史行（type 不在枚举内，或 amount <= 0 且不是下面清理的
-- 0 元贷款利息），本迁移会在拷贝数据阶段失败并整体回滚（迁移记录也不会写入），应用不会带病启动。
-- 出现这种情况请先人工核查：
--   SELECT id, type, amount, date, source_type, note FROM transactions
--    WHERE type NOT IN ('income','expense','transfer') OR amount <= 0;
-- 确认并修正数据后再重新启动（不要修改本迁移文件，迁移内容已被 hash 锁定）。

-- 先把「0 元贷款利息」这类空流水清掉，否则下面的 CHECK (amount > 0) 会直接拒绝建表后的拷贝。
-- 为什么可以删：0 利率贷款每期都会记一条「贷款利息 X 第 N 期」的 0 元支出（旧实现的无意义产物），
-- 金额为 0，对余额、收支、统计、负债的口径没有任何影响（0 加任何数都不变），
-- 删除它不改变任何账目数字；新实现已不再产生这类流水（见 modules/loans.ts 的零元腿跳过）。
-- 范围严格限定在「金额为 0 且是贷款利息」，其他任何非法行都不会被静默处理。
DELETE FROM transactions
 WHERE amount = 0
   AND (source_type = 'loan-interest' OR note LIKE '贷款利息%');

CREATE TABLE transactions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ledger_id TEXT REFERENCES ledgers(id) ON DELETE RESTRICT,
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
  updated_at TEXT NOT NULL,
  external_id TEXT,
  source_type TEXT,
  dedup_key TEXT,
  linked_transaction_id TEXT,
  payment_group_id TEXT,
  client_request_id TEXT
);
INSERT INTO transactions_new (id, user_id, ledger_id, account_id, category_id, type, amount, currency, note, date, transfer_to_account_id, recurring_id, created_at, updated_at, external_id, source_type, dedup_key, linked_transaction_id, payment_group_id, client_request_id)
  SELECT id, user_id, ledger_id, account_id, category_id, type, amount, currency, note, date, transfer_to_account_id, recurring_id, created_at, updated_at, external_id, source_type, dedup_key, linked_transaction_id, payment_group_id, client_request_id FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
CREATE INDEX idx_tx_user_date ON transactions(user_id, date);
CREATE INDEX idx_tx_user_account ON transactions(user_id, account_id);
CREATE INDEX idx_tx_ledger ON transactions(ledger_id);
CREATE UNIQUE INDEX uniq_recurring_tx ON transactions(recurring_id, date);
CREATE UNIQUE INDEX uniq_tx_external_source ON transactions(ledger_id, source_type, external_id);
CREATE INDEX idx_tx_dedup ON transactions(ledger_id, dedup_key);
CREATE UNIQUE INDEX uniq_tx_client_request
  ON transactions(ledger_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
