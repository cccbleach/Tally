import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { users, authSessions, passwordResetTokens } from "../db/schema.js";
import { AppError, badRequest, unauthorized } from "../lib/errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { Jwt } from "./jwt.js";
import { config } from "../config.js";

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

type UserRow = typeof users.$inferSelect;

function toDto(u: UserRow): UserDto {
  return { id: u.id, email: u.email, displayName: u.displayName, createdAt: u.createdAt };
}

// 账号归一化：邮箱统一小写；手机号去掉内部空格（保留开头的 +）。
function normalizeAccount(account: string): string {
  const t = account.trim();
  if (t.includes("@")) return t.toLowerCase();
  return t.replace(/\s+/g, "");
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// 解析 JWT TTL 字符串（如 "15m" / "30d"）为毫秒。
function ttlToMs(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) return 30 * 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  switch (m[2]) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default: return 30 * 24 * 60 * 60 * 1000;
  }
}

const REFRESH_TTL_MS = ttlToMs(config.refreshTokenTtl);
const RESET_TTL_MS = 30 * 60 * 1000;

export function makeAuthService(db: DB, jwt: Jwt) {
  // 创建登录会话：签发 access/refresh 并落库 refresh token 哈希。
  async function createSession(userId: string, deviceName?: string) {
    const refreshToken = await jwt.signRefresh(userId);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
    db.insert(authSessions)
      .values({
        id: randomUUID(),
        userId,
        refreshTokenHash: sha256(refreshToken),
        deviceName: deviceName ?? null,
        expiresAt,
        revokedAt: null,
        lastUsedAt: now,
        createdAt: now,
      })
      .run();
    const token = await jwt.signAccess(userId);
    return { token, refreshToken };
  }

  function revokeAllSessions(userId: string) {
    const now = new Date().toISOString();
    db.update(authSessions)
      .set({ revokedAt: now })
      .where(eq(authSessions.userId, userId))
      .run();
  }

  return {
    async register(account: string, password: string, displayName: string) {
      const normalized = normalizeAccount(account);
      if (!normalized) throw badRequest("INVALID_ACCOUNT", "请输入邮箱或手机号");
      const existing = db.select().from(users).where(eq(users.email, normalized)).get();
      if (existing) throw new AppError(409, "EMAIL_EXISTS", "该账号已注册");
      const now = new Date().toISOString();
      const passwordHash = await hashPassword(password);
      const user = {
        id: randomUUID(),
        email: normalized,
        passwordHash,
        displayName: displayName.trim() || (normalized.includes("@") ? (normalized.split("@")[0] ?? "用户") : "用户"),
        defaultLedgerId: null, // 注册后由 createDefaultLedger 填充
        currentLedgerId: null,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(users).values(user).run();
      const session = await createSession(user.id);
      return { user: toDto(user), ...session };
    },

    async login(account: string, password: string) {
      const normalized = normalizeAccount(account);
      const user = db.select().from(users).where(eq(users.email, normalized)).get();
      if (!user) throw unauthorized("INVALID_CREDENTIALS", "邮箱或密码错误");
      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) throw unauthorized("INVALID_CREDENTIALS", "邮箱或密码错误");
      const session = await createSession(user.id);
      return { user: toDto(user), ...session };
    },

    // 刷新轮换：旧 refresh 立即失效，签发新 access + 新 refresh。
    async refresh(refreshToken: string) {
      let payload;
      try {
        payload = await jwt.verify(refreshToken);
      } catch {
        throw unauthorized("INVALID_REFRESH_TOKEN", "刷新令牌无效");
      }
      if (payload.type !== "refresh") throw unauthorized("INVALID_REFRESH_TOKEN", "刷新令牌无效");
      const oldHash = sha256(refreshToken);
      const session = db.select().from(authSessions).where(eq(authSessions.refreshTokenHash, oldHash)).get();
      if (
        !session ||
        session.userId !== payload.sub ||
        session.revokedAt ||
        new Date(session.expiresAt).getTime() < Date.now()
      ) {
        throw unauthorized("INVALID_REFRESH_TOKEN", "刷新令牌无效或已失效");
      }
      const nextRefreshToken = await jwt.signRefresh(payload.sub);
      const nextAccessToken = await jwt.signAccess(payload.sub);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
      db.transaction((tx) => {
        tx.update(authSessions)
          .set({ revokedAt: now, lastUsedAt: now })
          .where(eq(authSessions.id, session.id))
          .run();
        tx.insert(authSessions)
          .values({
            id: randomUUID(),
            userId: payload.sub,
            refreshTokenHash: sha256(nextRefreshToken),
            deviceName: session.deviceName,
            expiresAt,
            revokedAt: null,
            lastUsedAt: now,
            createdAt: now,
          })
          .run();
      });
      return { token: nextAccessToken, refreshToken: nextRefreshToken };
    },

    // 验证码登录：已注册则直接登录；未注册则自动创建账号（默认昵称「用户」）。
    async loginPhone(phone: string) {
      const normalized = normalizeAccount(phone);
      const existing = db.select().from(users).where(eq(users.email, normalized)).get();
      if (existing) {
        const session = await createSession(existing.id);
        return { user: toDto(existing), created: false, ...session };
      }
      const now = new Date().toISOString();
      const user = {
        id: randomUUID(),
        email: normalized,
        passwordHash: "", // 无密码登录，后续可用“忘记密码”设密码
        displayName: "用户",
        defaultLedgerId: null,
        currentLedgerId: null,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(users).values(user).run();
      const session = await createSession(user.id);
      return { user: toDto(user), created: true, ...session };
    },

    // 生成 reset token 并落库（单次使用、短时效）。返回明文 token；是否回传由路由按生产/开发决定。
    async requestReset(account: string) {
      const normalized = normalizeAccount(account);
      const user = db.select().from(users).where(eq(users.email, normalized)).get();
      if (!user) return null; // 为安全起见不暴露账号是否存在
      const token = await jwt.signReset(user.id);
      const now = new Date().toISOString();
      db.insert(passwordResetTokens)
        .values({
          id: randomUUID(),
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString(),
          usedAt: null,
          createdAt: now,
        })
        .run();
      return token;
    },

    async resetPassword(resetToken: string, newPassword: string) {
      let payload;
      try {
        payload = await jwt.verify(resetToken);
      } catch {
        throw badRequest("INVALID_RESET_TOKEN", "重置令牌无效或已过期");
      }
      if (payload.type !== "reset") throw badRequest("INVALID_RESET_TOKEN", "重置令牌无效或已过期");
      const record = db.select().from(passwordResetTokens).where(eq(passwordResetTokens.tokenHash, sha256(resetToken))).get();
      if (!record || record.usedAt || new Date(record.expiresAt).getTime() < Date.now()) {
        throw badRequest("INVALID_RESET_TOKEN", "重置令牌无效或已过期");
      }
      const user = db.select().from(users).where(eq(users.id, payload.sub)).get();
      if (!user) throw badRequest("INVALID_RESET_TOKEN", "重置令牌无效或已过期");
      if (user.id !== record.userId) throw badRequest("INVALID_RESET_TOKEN", "重置令牌无效或已过期");
      const passwordHash = await hashPassword(newPassword);
      db.transaction(() => {
        db.update(passwordResetTokens)
          .set({ usedAt: new Date().toISOString() })
          .where(eq(passwordResetTokens.id, record.id))
          .run();
        db.update(users)
          .set({ passwordHash, updatedAt: new Date().toISOString() })
          .where(eq(users.id, user.id))
          .run();
        revokeAllSessions(user.id);
      });
    },

    async me(userId: string) {
      const user = db.select().from(users).where(eq(users.id, userId)).get();
      if (!user) throw unauthorized("UNAUTHORIZED", "用户不存在");
      return { user: toDto(user) };
    },
  };
}
