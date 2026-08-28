-- 里程碑十：贷款还款幂等改为数据库级。
-- 以 (actor_user_id, loan_id, idempotency_key) 唯一索引作为并发认领：
-- 同一用户对同一笔贷款用同一幂等键同时提交时，只有最先插入的一方能胜出，
-- 其余并发请求命中 UNIQUE 冲突后重新读取已完成的 result_json 返回（replayed=true），
-- 而不是返回 INSTALLMENT_ALREADY_PAID。
-- 认领、期次条件更新、两条流水、贷款余额、审计日志全部在同一个事务内提交。
CREATE TABLE loan_payment_idempotency (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  loan_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',  -- completed
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_loan_pay_idem ON loan_payment_idempotency(actor_user_id, loan_id, idempotency_key);
CREATE INDEX idx_loan_pay_idem_loan ON loan_payment_idempotency(loan_id);
