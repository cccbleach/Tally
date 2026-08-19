-- 账单导入去重：external_id 记录“来源账单里的唯一流水号”
-- 普通唯一索引：external_id 为 NULL 的行（手工/其他来源）互不冲突
ALTER TABLE transactions ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX uniq_tx_external ON transactions(user_id, external_id);
