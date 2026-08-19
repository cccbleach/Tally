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

export function makeAuthService(db: DB, jwt: Jwt) {
  return {
    async register(email: string, password: string, displayName: string) {
      const normalized = email.trim().toLowerCase();
      if (!normalized) throw badRequest("INVALID_EMAIL", "邮箱不能为空");
      const existing = db.select().from(users).where(eq(users.email, normalized)).get();
      if (existing) throw new AppError(409, "EMAIL_EXISTS", "该邮箱已注册");
      const now = new Date().toISOString();
      const passwordHash = await hashPassword(password);
      const user = {
        id: randomUUID(),
        email: normalized,
        passwordHash,
        displayName: displayName.trim() || normalized.split("@")[0] || "用户",
        defaultLedgerId: null, // 注册后由 createDefaultLedger 填充
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

    async login(email: string, password: string) {
      const normalized = email.trim().toLowerCase();
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

    async requestReset(email: string) {
      const normalized = email.trim().toLowerCase();
      const user = db.select().from(users).where(eq(users.email, normalized)).get();
      if (!user) return null; // 为安全起见不暴露邮箱是否存在
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
