-- 审计日志（阶段 5）：记录家庭成员变更、贷款/信用卡还款等关键写操作
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  ledger_id TEXT,
  actor_user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_ledger ON audit_logs(ledger_id);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id);
