-- 导入加固（阶段 4）：硬去重只使用稳定来源 ID，软去重 dedup_key 不再做硬唯一。
-- 1) 硬去重：UNIQUE(ledger_id, source_type, external_id)
--    同一账本、同一来源、同一外部号的流水应唯一；不同来源 / 不同账本互不影响。
--    SQLite 唯一索引中 NULL 互不冲突，因此手工流水（external_id 为 NULL）不受影响。
-- 2) 软去重：dedup_key 改为普通索引（用于疑似重复查询），不再作为数据库硬唯一约束，
--    从而允许“两笔同商家同金额的正常消费”都保留。
-- 3) import_items 增加账户/分类/去重指纹/来源/评分/错误码字段，支撑预览逐项调整。

-- 先移除旧的硬唯一索引（dedup_key 与 旧的 user+external）
DROP INDEX IF EXISTS uniq_tx_dedup;
DROP INDEX IF EXISTS uniq_tx_external;

-- 硬去重：同一账本 + 同一来源 + 同一外部 ID 唯一（NULL 互不冲突）
CREATE UNIQUE INDEX uniq_tx_external_source ON transactions(ledger_id, source_type, external_id);

-- 软去重 dedup_key 普通索引，不唯一
CREATE INDEX idx_tx_dedup ON transactions(ledger_id, dedup_key);

-- import_items 扩展（预览逐项确认所需字段）
ALTER TABLE import_items ADD COLUMN account_id TEXT;
ALTER TABLE import_items ADD COLUMN category_id TEXT;
ALTER TABLE import_items ADD COLUMN dedup_key TEXT;
ALTER TABLE import_items ADD COLUMN source TEXT;
ALTER TABLE import_items ADD COLUMN duplicate_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_items ADD COLUMN error_code TEXT;
