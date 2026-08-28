-- 认证安全（里程碑二阶段4）：
-- 1) auth_sessions：服务端记录 refresh token（仅存哈希），实现刷新轮换与“重用旧 token 即撤销会话”。
-- 2) password_reset_tokens：重置令牌单次使用、短时效，修改密码后撤销全部旧会话。
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  device_name TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
CREATE UNIQUE INDEX uniq_auth_sessions_refresh ON auth_sessions(refresh_token_hash);

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id);
CREATE UNIQUE INDEX uniq_password_reset_token ON password_reset_tokens(token_hash);
