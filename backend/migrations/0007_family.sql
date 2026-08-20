-- 家庭与成员 + 共享账本
CREATE TABLE families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_families_owner ON families(owner_user_id);

CREATE TABLE family_members (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
  is_active INTEGER NOT NULL DEFAULT 1,
  joined_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_family_member ON family_members(family_id, user_id);

-- 账本归属家庭（NULL=个人账本）
ALTER TABLE ledgers ADD COLUMN family_id TEXT;
CREATE INDEX idx_ledgers_family ON ledgers(family_id);

-- 用户当前选中账本（客户端切换后保存，便于服务端“不传 ledgerId 用当前”）
ALTER TABLE users ADD COLUMN current_ledger_id TEXT;
