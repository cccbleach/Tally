-- 家庭生命周期（里程碑二）：邀请加入 + 角色 + 所有权转移 + 退出/删除。
-- 不再“输入账号直接加入”，改为先发邀请、由对方确认。
CREATE TABLE family_invitations (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  inviter_user_id TEXT NOT NULL,
  target_account_hash TEXT NOT NULL,      -- 受邀账号（邮箱/手机号，归一化后）的 SHA-256
  role TEXT NOT NULL DEFAULT 'member',    -- member | viewer | admin
  token_hash TEXT NOT NULL,               -- 邀请链接 token 的 SHA-256（只在响应中返回明文一次）
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined | revoked
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_family_invites_family ON family_invitations(family_id);
CREATE INDEX idx_family_invites_target ON family_invitations(target_account_hash);
CREATE INDEX idx_family_invites_token ON family_invitations(token_hash);
