-- 周期账单幂等改造
-- 1) 为流水表增加可空的 recurring_id 关联字段（历史数据为 NULL）
-- 2) 建立 (recurring_id, date) 唯一索引：SQLite 中 NULL 相互不冲突，不影响普通手工流水
ALTER TABLE transactions ADD COLUMN recurring_id TEXT;
CREATE UNIQUE INDEX uniq_recurring_tx ON transactions(recurring_id, date);
