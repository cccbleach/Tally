import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { users, authSessions } from "../db/schema.js";
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

    // 账号是否存在（找回验证码只发给已注册手机号，避免“返回成功但拿不到验证码”）。
    accountExists(account: string): boolean {
      const normalized = normalizeAccount(account);
      if (!normalized) return false;
      return !!db.select({ id: users.id }).from(users).where(eq(users.email, normalized)).get();
    },

    // 短信验证码通过后的密码恢复：设置新密码 + 吊销全部会话。
    // 调用方（路由）必须先完成验证码校验；这里只认已注册账号。
    async setPasswordBySms(account: string, newPassword: string) {
      const normalized = normalizeAccount(account);
      const user = db.select().from(users).where(eq(users.email, normalized)).get();
      if (!user) throw new AppError(404, "ACCOUNT_NOT_FOUND", "该手机号未注册");
      const passwordHash = await hashPassword(newPassword);
      db.transaction(() => {
        db.update(users)
          .set({ passwordHash, updatedAt: new Date().toISOString() })
          .where(eq(users.id, user.id))
          .run();
        revokeAllSessions(user.id);
      });
      return { user: toDto(user) };
    },

    async me(userId: string) {
      const user = db.select().from(users).where(eq(users.id, userId)).get();
      if (!user) throw unauthorized("UNAUTHORIZED", "用户不存在");
      return { user: toDto(user) };
    },
  };
}
