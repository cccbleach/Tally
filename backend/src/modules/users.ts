import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { users, nicknameHistory } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { badRequest, conflict, notFound, tooManyRequests } from "../lib/errors.js";
import { nicknameKey, validateNickname, isNicknameAvailable, isNicknameUniqueViolation } from "../lib/nickname.js";
import { maskPhone } from "../lib/phone.js";
import { toUserDto } from "../auth/service.js";
import type { Jwt } from "../auth/jwt.js";
import type { createRateLimiter } from "../lib/rateLimit.js";
import { config } from "../config.js";
import { randomUUID } from "node:crypto";

type AuthLimiter = ReturnType<typeof createRateLimiter>;

const NICKNAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const NICKNAME_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 旧昵称保留 30 天

function clientIp(req: FastifyRequest): string {
  if (config.trustedProxyCount <= 0) {
    return req.socket.remoteAddress ?? "unknown";
  }
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      const idx = Math.max(0, parts.length - config.trustedProxyCount);
      return parts[idx] ?? (req.socket.remoteAddress ?? "unknown");
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function registerUserRoutes(
  app: FastifyInstance,
  deps: { db: AppDb["db"]; jwt: Jwt; userLimiter: AuthLimiter },
) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

  // 昵称可用性：公开接口（onboarding 阶段无 token 也可调用），带严格限流。
  // 与 complete-profile / 修改昵称共用同一判重逻辑（包含未过期 nickname_history）。
  app.get("/api/v1/users/nickname-availability", async (req) => {
    const limiter = deps.userLimiter;
    if (config.enableRateLimit) {
      const { allowed } = limiter("np:" + clientIp(req));
      if (!allowed) throw tooManyRequests("RATE_LIMITED", "请求过于频繁，请稍后再试");
    }
    const q = req.query as { nickname?: string };
    const nickname = (q.nickname ?? "").trim();
    if (!nickname) return { available: false, reason: "不能为空" };
    const err = validateNickname(nickname);
    if (err) return { available: false, reason: err };
    const available = isNicknameAvailable(db, nickname);
    return { available, reason: available ? null : "该昵称已被使用" };
  });

  // 修改昵称：30 天冷却 + 全局判重（含未过期历史）+ 旧昵称保留 30 天。
  app.patch("/api/v1/users/me/nickname", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = z.object({ nickname: z.string().min(1, "昵称不能为空") }).parse(req.body);
    const err = validateNickname(body.nickname);
    if (err) throw badRequest("INVALID_NICKNAME", err);

    const me = db.select().from(users).where(eq(users.id, userId)).get();
    if (!me) throw notFound("USER_NOT_FOUND", "用户不存在");

    // 冷却期检查：仅在确实要改动昵称时才受限
    const key = nicknameKey(body.nickname);
    if (me.nicknameKey !== key && me.nicknameChangedAt) {
      const changeTime = new Date(me.nicknameChangedAt).getTime();
      if (Date.now() - changeTime < NICKNAME_CHANGE_COOLDOWN_MS) {
        throw conflict(
          "NICKNAME_CHANGE_COOLDOWN",
          "30 天内只能修改一次昵称，请稍后再试",
        );
      }
    }

    if (!isNicknameAvailable(db, body.nickname, userId)) {
      throw conflict("NICKNAME_TAKEN", "该昵称已被使用");
    }

    const now = new Date().toISOString();
    try {
      db.transaction(() => {
        // 旧昵称入历史（保留 30 天）
        if (me.nickname && me.nicknameKey) {
          db.insert(nicknameHistory)
            .values({
              id: randomUUID(),
              userId,
              nickname: me.nickname,
              nicknameKey: me.nicknameKey,
              changedAt: now,
              expiresAt: new Date(Date.now() + NICKNAME_HISTORY_RETENTION_MS).toISOString(),
            })
            .run();
        }
        db.update(users)
          .set({
            nickname: body.nickname,
            nicknameKey: key,
            nicknameChangedAt: now,
            updatedAt: now,
          })
          .where(eq(users.id, userId))
          .run();
      });
    } catch (e) {
      // 数据库唯一约束（并发撞名）→ 统一 409 NICKNAME_TAKEN
      if (isNicknameUniqueViolation(e)) throw conflict("NICKNAME_TAKEN", "该昵称已被使用");
      throw e;
    }
    const updated = db.select().from(users).where(eq(users.id, userId)).get();
    return { user: toUserDto(updated as typeof users.$inferSelect) };
  });

  // 本人资料（含脱敏手机号，手机号仅本人接口可见）
  app.get("/api/v1/users/me", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const me = db.select().from(users).where(eq(users.id, userId)).get();
    if (!me) throw notFound("USER_NOT_FOUND", "用户不存在");
    const dto = toUserDto(me as typeof users.$inferSelect);
    return { user: { ...dto, phoneMasked: maskPhone(dto.phone) } };
  });
}
