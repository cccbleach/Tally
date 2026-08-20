-- 跨来源去重与关联
ALTER TABLE transactions ADD COLUMN source_type TEXT;        -- manual | wechat | alipay | bank | import
ALTER TABLE transactions ADD COLUMN dedup_key TEXT;          -- 跨来源指纹（日期+金额+币种+规范化商家）
ALTER TABLE transactions ADD COLUMN linked_transaction_id TEXT; -- 人工关联的目标流水
CREATE UNIQUE INDEX uniq_tx_dedup ON transactions(ledger_id, dedup_key);
