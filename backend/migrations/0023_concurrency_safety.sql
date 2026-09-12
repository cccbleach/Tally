-- 里程碑 P2 并发安全：
-- 1) accounts / categories 补 updated_at（乐观锁冲突检测），存量行回填 created_at；
--    此前只有流水/预算/周期账单支持 expectedUpdatedAt，家庭共享账本下
--    两个成员并发改同一账户/分类会静默相互覆盖（Last-Write-Wins 且无感知）。
-- 2) transactions.client_request_id：客户端幂等键，离线写队列断网重放时
--    凭 (ledger_id, client_request_id) 唯一索引防止重复入账。
--    部分索引：手工/导入/周期生成的流水不携带该键（NULL 不参与唯一约束）。
ALTER TABLE accounts ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE accounts SET updated_at = created_at WHERE updated_at = '';

ALTER TABLE categories ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE categories SET updated_at = created_at WHERE updated_at = '';

ALTER TABLE transactions ADD COLUMN client_request_id TEXT;
CREATE UNIQUE INDEX uniq_tx_client_request
  ON transactions(ledger_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
