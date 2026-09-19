// 昵称规则与规范化：全局唯一公开账号身份（用于家庭邀请与成员展示）。
// 规则（见目标规格）：
//   - 2–20 个字符（按 Unicode 码点计数）
//   - 允许中文、Unicode 字母、数字、下划线；禁止空格、emoji、其它符号
//   - 禁止纯数字
//   - NFKC 归一化 + 大小写不敏感判重
//   - 保留系统词：tally/admin/system/官方/管理员/系统/用户（不占用用户昵称）
import { and, eq, gte } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { users, nicknameHistory } from "../db/schema.js";

const RESERVED = new Set([
  "tally",
  "admin",
  "system",
  "官方",
  "管理员",
  "系统",
  "用户",
]);

const NICKNAME_LEN_MAX = 20;
const NICKNAME_LEN_MIN = 2;

// 生成判重键：NFKC + trim + 小写。所有写入 nickname_key 的地方都必须走这里。
export function nicknameKey(nickname: string): string {
  return nickname.normalize("NFKC").trim().toLowerCase();
}

export function isReserved(nickname: string): boolean {
  return RESERVED.has(nicknameKey(nickname));
}

// 校验昵称是否满足规则。返回 null 表示合法，否则返回错误文案。
export function validateNickname(nickname: string): string | null {
  if (!nickname) return "昵称不能为空";
  const key = nicknameKey(nickname);
  if (key.length < NICKNAME_LEN_MIN || key.length > NICKNAME_LEN_MAX) {
    return `昵称长度为 ${NICKNAME_LEN_MIN}-${NICKNAME_LEN_MAX} 个字符`;
  }
  if (/^\d+$/.test(key)) return "昵称不能是纯数字";
  // 允许：中文、Unicode 字母、数字、下划线。禁空格、emoji、其它符号。
  if (!/^[\p{Script=Han}\p{L}\p{N}_]+$/u.test(key)) {
    return "昵称只能包含中文、字母、数字或下划线（不能包含空格或 emoji）";
  }
  if (isReserved(key)) return "该昵称为系统保留词";
  return null;
}

// 全局唯一判重（complete-profile / 修改昵称 / availability 三处共用）：
// 占用来源为 users.nickname_key 以及「未过期」的 nickname_history（旧昵称保留期内不可被他人占用）。
// exceptUserId 用于排除调用者自己（允许占用自己名下的旧昵称）。nowIso 允许测试注入时间。
export function isNicknameAvailable(db: DB, nickname: string, exceptUserId?: string, nowIso?: string): boolean {
  const key = nicknameKey(nickname);
  const now = nowIso ?? new Date().toISOString();
  const owner = db.select({ id: users.id }).from(users).where(eq(users.nicknameKey, key)).all();
  if (owner.some((u) => u.id !== exceptUserId)) return false;
  const hist = db
    .select({ userId: nicknameHistory.userId })
    .from(nicknameHistory)
    .where(and(eq(nicknameHistory.nicknameKey, key), gte(nicknameHistory.expiresAt, now)))
    .all();
  if (hist.some((h) => h.userId !== exceptUserId)) return false;
  return true;
}

// 判断一次数据库写冲突是否【确实】因 nickname_key 唯一约束触发
// （用于统一转成 409 NICKNAME_TAKEN）。必须精确匹配该索引，
// 不能把其它 SQLITE_CONSTRAINT（例如触发器 RAISE(ABORT) 的业务失败）误判为撞名。
export function isNicknameUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  const code = (e?.code ?? "").toUpperCase();
  const msg = e?.message ?? "";
  if (/uniq_users_nickname_key|nickname_key/i.test(msg)) return true;
  // 老版本 SQLite 报错可能不带列名：只有「纯唯一约束」错误且没有其它明确指向时，
  // 才按撞名处理（避免吞掉触发器/其它约束的真实失败）。
  if (code === "SQLITE_CONSTRAINT_UNIQUE" && !/family|ledger|auth_session/i.test(msg)) return true;
  return false;
}
