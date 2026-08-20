import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { users } from "../db/schema.js";
import { AppError, badRequest, unauthorized } from "../lib/errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { Jwt } from "./jwt.js";

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

export function makeAuthService(db: DB, jwt: Jwt) {
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
      return {
        user: toDto(user),
        token: await jwt.signAccess(user.id),
        refreshToken: await jwt.signRefresh(user.id),
      };
    },

    async login(account: string, password: string) {
      const normalized = normalizeAccount(account);
      const user = db.select().from(users).where(eq(users.email, normalized)).get();
      if (!user) throw unauthorized("INVALID_CREDENTIALS", "邮箱或密码错误");
      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) throw unauthorized("INVALID_CREDENTIALS", "邮箱或密码错误");
      return {
        user: toDto(user),
        token: await jwt.signAccess(user.id),
        refreshToken: await jwt.signRefresh(user.id),
      };
    },

    async refresh(userId: string) {
      const user = db.select().from(users).where(eq(users.id, userId)).get();
      if (!user) throw unauthorized("UNAUTHORIZED", "用户不存在");
      return {
        token: await jwt.signAccess(user.id),
        refreshToken: await jwt.signRefresh(user.id),
      };
    },

    // 验证码登录：已注册则直接登录；未注册则自动创建账号（默认昵称「用户」）。
    async loginPhone(phone: string) {
      const normalized = normalizeAccount(phone);
      const existing = db.select().from(users).where(eq(users.email, normalized)).get();
      if (existing) {
        return {
          user: toDto(existing),
          created: false,
          token: await jwt.signAccess(existing.id),
          refreshToken: await jwt.signRefresh(existing.id),
        };
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
      return {
        user: toDto(user),
        created: true,
        token: await jwt.signAccess(user.id),
        refreshToken: await jwt.signRefresh(user.id),
      };
    },

    async requestReset(account: string) {
      const normalized = normalizeAccount(account);
      const user = db.select().from(users).where(eq(users.email, normalized)).get();
      if (!user) return null; // 为安全起见不暴露账号是否存在
      return await jwt.signReset(user.id);
    },

    async resetPassword(resetToken: string, newPassword: string) {
      const payload = await jwt.verify(resetToken);
      if (payload.type !== "reset") throw badRequest("INVALID_RESET_TOKEN", "重置令牌无效或已过期");
      const user = db.select().from(users).where(eq(users.id, payload.sub)).get();
      if (!user) throw badRequest("INVALID_RESET_TOKEN", "重置令牌无效或已过期");
      const passwordHash = await hashPassword(newPassword);
      db.update(users)
        .set({ passwordHash, updatedAt: new Date().toISOString() })
        .where(eq(users.id, user.id))
        .run();
    },

    async me(userId: string) {
      const user = db.select().from(users).where(eq(users.id, userId)).get();
      if (!user) throw unauthorized("UNAUTHORIZED", "用户不存在");
      return { user: toDto(user) };
    },
  };
}
