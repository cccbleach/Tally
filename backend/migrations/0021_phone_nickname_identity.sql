-- mode: fk-off
-- 里程碑十一：手机号 + 唯一昵称身份（上线加固版）。
-- 重建 users 表：
--   旧字段 email/password_hash/display_name 移除；
--   新字段 phone（+86 E.164，全局唯一）、nickname（公开昵称，可空=未完成）、
--   nickname_key（NFKC+大小写不敏感 判重键，部分唯一）、
--   phone_verified_at / nickname_changed_at / profile_completed_at。
-- 迁移规则（严格守门）：
--   1) 手机号：只接受中国大陆 11 位（1[3-9] 开头），允许 +86/86 前缀与内部空格；
--      任何邮箱账号或非大陆手机号都会使迁移整体中止（SQLite 事务回滚到升级前）。
--   2) 昵称：candidate 必须通过应用同等规则（2-20 字、无空格、仅 ASCII/CJK/下划线、
--      非纯数字、非保留词）才迁移为公开昵称；否则置空并转入 onboarding。
--   3) 昵称判重键按 NFKC+小写（SQLite 内用 lower(trim) 近似；含全角/emoji 等不稳定字符的
--      一律路由到 onboarding，避免错误归一）。迁移出的非空 key 若冲突 → 整体中止。
--   4) 升级即吊销全部旧会话，强制重新登录/完成昵称。
-- 所有对 users(id) 的外键引用保持不变（SQLite 表重建后同名仍可解析）。

CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  nickname TEXT,
  nickname_key TEXT,
  phone_verified_at TEXT,
  nickname_changed_at TEXT,
  profile_completed_at TEXT,
  default_ledger_id TEXT,
  current_ledger_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_users_nickname_key ON users_new(nickname_key) WHERE nickname_key IS NOT NULL;
CREATE INDEX idx_users_phone ON users_new(phone);
CREATE INDEX idx_users_profile ON users_new(profile_completed_at);

-- 严格手机号守门：phone 列必须为 '+86' + 11 位大陆号；否则中止。
CREATE TRIGGER guard_0021_phone BEFORE INSERT ON users_new
WHEN NEW.phone = '' OR NEW.phone NOT GLOB '+861[3-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
BEGIN
  SELECT RAISE(ABORT, '0021 迁移中止：存在非大陆手机号/邮箱旧账号（无法按 +86 E.164 解析）。请先人工处理后再升级。');
END;

-- 昵称 key 冲突守门：迁移出的非空 key 出现重复 → 中止（避免静默占用错位）。
CREATE TRIGGER guard_0021_nickname_dup BEFORE INSERT ON users_new
WHEN NEW.nickname_key IS NOT NULL AND EXISTS (SELECT 1 FROM users_new WHERE nickname_key = NEW.nickname_key)
BEGIN
  SELECT RAISE(ABORT, '0021 迁移中止：旧昵称按 NFKC+小写归一后冲突（' || NEW.nickname_key || '）。请先人工处理或拆除冲突昵称后重试。');
END;

INSERT INTO users_new (
  id,
  phone,
  nickname,
  nickname_key,
  phone_verified_at,
  nickname_changed_at,
  profile_completed_at,
  default_ledger_id,
  current_ledger_id,
  created_at,
  updated_at
)
SELECT
  id,
  CASE WHEN p = '' THEN '' ELSE '+86' || p END AS phone,
  CASE
    WHEN disp IS NULL THEN NULL
    WHEN length(disp) < 2 OR length(disp) > 20 THEN NULL
    WHEN disp GLOB '* *' THEN NULL
    WHEN disp GLOB '*[^A-Za-z0-9_一-鿿]*' THEN NULL
    WHEN disp NOT GLOB '*[^0-9]*' THEN NULL
    WHEN lower(trim(disp)) IN ('tally','admin','system','官方','管理员','系统','用户') THEN NULL
    ELSE disp
  END AS nickname,
  CASE
    WHEN disp IS NULL THEN NULL
    WHEN length(disp) < 2 OR length(disp) > 20 THEN NULL
    WHEN disp GLOB '* *' THEN NULL
    WHEN disp GLOB '*[^A-Za-z0-9_一-鿿]*' THEN NULL
    WHEN disp NOT GLOB '*[^0-9]*' THEN NULL
    WHEN lower(trim(disp)) IN ('tally','admin','system','官方','管理员','系统','用户') THEN NULL
    ELSE lower(trim(disp))
  END AS nickname_key,
  CASE WHEN p = '' THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END AS phone_verified_at,
  CASE
    WHEN disp IS NULL THEN NULL
    WHEN length(disp) < 2 OR length(disp) > 20 THEN NULL
    WHEN disp GLOB '* *' THEN NULL
    WHEN disp GLOB '*[^A-Za-z0-9_一-鿿]*' THEN NULL
    WHEN disp NOT GLOB '*[^0-9]*' THEN NULL
    WHEN lower(trim(disp)) IN ('tally','admin','system','官方','管理员','系统','用户') THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  END AS nickname_changed_at,
  CASE
    WHEN disp IS NULL THEN NULL
    WHEN length(disp) < 2 OR length(disp) > 20 THEN NULL
    WHEN disp GLOB '* *' THEN NULL
    WHEN disp GLOB '*[^A-Za-z0-9_一-鿿]*' THEN NULL
    WHEN disp NOT GLOB '*[^0-9]*' THEN NULL
    WHEN lower(trim(disp)) IN ('tally','admin','system','官方','管理员','系统','用户') THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  END AS profile_completed_at,
  default_ledger_id,
  current_ledger_id,
  created_at,
  updated_at
FROM (
  SELECT
    id,
    email,
    display_name,
    default_ledger_id,
    current_ledger_id,
    created_at,
    updated_at,
    CASE WHEN trim(display_name) = '' OR display_name = '用户' THEN NULL ELSE trim(display_name) END AS disp,
    CASE
      WHEN trim(email) = '' THEN ''
      WHEN replace(
        CASE
          WHEN email GLOB '+86 *' THEN substr(email, 4)
          WHEN email GLOB '+86*' THEN substr(email, 4)
          WHEN email GLOB '86 *' THEN substr(email, 4)
          WHEN email GLOB '86*' THEN substr(email, 3)
          ELSE email
        END, ' ', '') GLOB '1[3-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' THEN replace(
          CASE
            WHEN email GLOB '+86 *' THEN substr(email, 4)
            WHEN email GLOB '+86*' THEN substr(email, 4)
            WHEN email GLOB '86 *' THEN substr(email, 4)
            WHEN email GLOB '86*' THEN substr(email, 3)
            ELSE email
          END, ' ', '')
      ELSE ''
    END AS p
  FROM users
);

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- 升级即吊销全部旧会话：强制重新登录；旧“用户”账号下次登录走强制昵称设置。
UPDATE auth_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE revoked_at IS NULL;

-- 一次性 onboarding ticket：令牌只存哈希、10 分钟过期、仅可使用一次。
CREATE TABLE onboarding_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_onboarding_user ON onboarding_tickets(user_id);
CREATE INDEX idx_onboarding_token ON onboarding_tickets(token_hash);

-- 昵称历史保留表：改名后旧昵称保留 30 天（供恢复/审计）。
CREATE TABLE nickname_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  nickname_key TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_nickname_history_user ON nickname_history(user_id);
CREATE INDEX idx_nickname_history_key ON nickname_history(nickname_key);
