-- 里程碑九：预算唯一性改为账本作用域 + 账本软删除
-- 1) 预算唯一性：业务作用域从 userId 改为 ledgerId + year + month + categoryId。
--    解决同一用户同时拥有个人账本与家庭账本、同月份同分类预算触发 500 UNIQUE 冲突。
--    SQLite 对部分唯一索引（WHERE）的替换需 DROP 旧索引 + CREATE 新索引。
-- 2) ledgers 增加 deleted_at：家庭删除后软删除家庭账本，保留历史财务数据但任何人（含原属主）不可访问。

-- ---------- 1) 预算唯一索引切换到账本作用域 ----------
DROP INDEX IF EXISTS uniq_budget_total;
DROP INDEX IF EXISTS uniq_budget_cat;
CREATE UNIQUE INDEX uniq_budget_total ON budgets(ledger_id, year, month) WHERE category_id IS NULL;
CREATE UNIQUE INDEX uniq_budget_cat ON budgets(ledger_id, year, month, category_id) WHERE category_id IS NOT NULL;

-- ---------- 2) ledgers 软删除字段 ----------
ALTER TABLE ledgers ADD COLUMN deleted_at TEXT;
CREATE INDEX idx_ledgers_deleted ON ledgers(deleted_at);
