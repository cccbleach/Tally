-- mode: fk-off
-- 里程碑十二：单家庭模型 + 昵称邀请（上线加固版）。
--   1) 每个账号最多属于一个 active 家庭：family_members(user_id) 部分唯一索引（is_active=1）。
--   2) 每个家庭仅允许一个未删除共享账本：ledgers(family_id) 部分唯一索引（deleted_at IS NULL）。
--   3) 邀请改为保存 target_user_id（按昵称找到目标用户），移除账号哈希与外部 token 依赖。
--   4) 同一家庭不能重复邀请同一用户：部分唯一索引 (family_id, target_user_id) WHERE status='pending'。
--   5) 角色收敛为 owner/member。
--
-- 显式守门策略（不静默迁移、不静默删数据）：
--   - 旧 family_members 若含 owner/member 以外的角色（viewer/admin）→ 整体中止，
--     避免“静默把 viewer 提权为 member”。
--   - 旧 family_invitations 若存在任何行 → 整体中止，避免“宣称保留数据却删除邀请”
--     （旧 target_account_hash 是单向哈希，无法回映射到新 user，无法安全迁移）。
--   守门在 DDL 之前通过临时表触发器执行：命中即 RAISE(ABORT)，整个 fk-off 事务回滚。
--   生产库当前无家庭/成员/邀请数据，因此升级直接通过；非空旧数据会得到明确失败提示。

-- ---------- 0) 守门（在任何 DDL 之前） ----------
CREATE TABLE _guard_0022 (v INTEGER);
CREATE TRIGGER guard_0022 BEFORE INSERT ON _guard_0022
WHEN (EXISTS (SELECT 1 FROM family_members WHERE role NOT IN ('owner', 'member')))
  OR (EXISTS (SELECT 1 FROM family_invitations))
BEGIN
  SELECT RAISE(ABORT, '0022 迁移中止：旧家庭数据含 viewer/admin 角色或存量邀请（target_account_hash 无法回映射），无法安全迁移。请先人工清理（移除多余角色、清空旧邀请或按新结构重建）后再升级。');
END;
INSERT INTO _guard_0022 VALUES (1);
DROP TABLE _guard_0022;

-- ---------- 1) family_members：仅一个 active 家庭 + 角色收敛 ----------
-- 守门已保证存量只有 owner/member，因此角色原样复制，不做任何隐式提权/降权。
CREATE TABLE family_members_new (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  joined_at TEXT NOT NULL,
  UNIQUE (family_id, user_id)
);
INSERT INTO family_members_new (id, family_id, user_id, role, is_active, joined_at)
  SELECT id, family_id, user_id, role, is_active, joined_at FROM family_members;
DROP TABLE family_members;
ALTER TABLE family_members_new RENAME TO family_members;
CREATE UNIQUE INDEX uniq_family_member_active ON family_members(family_id, user_id) WHERE is_active = 1;
CREATE UNIQUE INDEX uniq_family_single_active ON family_members(user_id) WHERE is_active = 1;

-- ---------- 2) ledgers：每家庭仅一个未删除共享账本 ----------
CREATE UNIQUE INDEX uniq_family_active_ledger ON ledgers(family_id) WHERE deleted_at IS NULL;

-- ---------- 3) family_invitations：target_user_id + 无外部 token ----------
-- 守门已保证旧邀请数量为 0，因此直接建空表（不存在“静默删除”）。
CREATE TABLE family_invitations_new (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
DROP TABLE family_invitations;
ALTER TABLE family_invitations_new RENAME TO family_invitations;
CREATE INDEX idx_family_invites_family ON family_invitations(family_id);
CREATE INDEX idx_family_invites_target ON family_invitations(target_user_id);
CREATE UNIQUE INDEX uniq_family_invite_pending ON family_invitations(family_id, target_user_id) WHERE status = 'pending';
