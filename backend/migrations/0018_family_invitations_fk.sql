-- mode: fk-off
-- 家庭邀请外键（0017 建立 family_invitations 表，本迁移补齐外键）：
-- family_id → families(id) ON DELETE CASCADE（删除家庭时清理邀请）
-- inviter_user_id → users(id) ON DELETE CASCADE
CREATE TABLE family_invitations_new (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_account_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO family_invitations_new (id, family_id, inviter_user_id, target_account_hash, role, token_hash, status, expires_at, accepted_at, created_at, updated_at)
  SELECT id, family_id, inviter_user_id, target_account_hash, role, token_hash, status, expires_at, accepted_at, created_at, updated_at FROM family_invitations;
DROP TABLE family_invitations;
ALTER TABLE family_invitations_new RENAME TO family_invitations;
CREATE INDEX idx_family_invites_family ON family_invitations(family_id);
CREATE INDEX idx_family_invites_target ON family_invitations(target_account_hash);
CREATE INDEX idx_family_invites_token ON family_invitations(token_hash);
