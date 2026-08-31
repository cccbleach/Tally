import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import type { Jwt } from "./jwt.js";
import { makeAuthService } from "./service.js";
import { makeAuth, getUserId } from "../middleware/auth.js";
import { AppError, badRequest, tooManyRequests } from "../lib/errors.js";
import type { createRateLimiter } from "../lib/rateLimit.js";
import type { OtpStore } from "../lib/otp.js";
import { checkVerifyCode, sendVerifyCode } from "../lib/sms.js";
import { config } from "../config.js";
import { normalizePhone } from "../lib/phone.js";

type AuthLimiter = ReturnType<typeof createRateLimiter>;

function clientIp(req: FastifyRequest): string {
  if (config.trustedProxyCount <= 0) {
    return req.socket.remoteAddress ?? "unknown";
  }
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    const parts = fwd
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const idx = Math.max(0, parts.length - config.trustedProxyCount);
      return parts[idx] ?? (req.socket.remoteAddress ?? "unknown");
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

function enforceLimiter(limiter: AuthLimiter, key: string) {
  if (!config.enableRateLimit) return;
  const { allowed } = limiter(key);
  if (!allowed) throw tooManyRequests("RATE_LIMITED", "请求过于频繁，请稍后再试");
}

function enforceAuthLimits(limiter: AuthLimiter, req: FastifyRequest, account?: string) {
  enforceLimiter(limiter, "ip:" + clientIp(req));
  if (account) enforceLimiter(limiter, "account:" + account);
}

const requestCodeSchema = z.object({
  phone: z.string().min(5, "请输入手机号").max(20, "手机号过长"),
});

const loginCodeSchema = z.object({
  phone: z.string().min(5, "请输入手机号").max(20, "手机号过长"),
  code: z.string().min(4, "验证码长度为 4-8 位").max(8, "验证码长度为 4-8 位"),
});

const completeProfileSchema = z.object({
  onboardingToken: z.string().min(1, "缺少 onboarding 令牌"),
  nickname: z.string().min(1, "昵称不能为空"),
});

// 旧邮箱/密码流程统一 410：AUTH_METHOD_REMOVED
function authMethodRemoved(): AppError {
  return new AppError(410, "AUTH_METHOD_REMOVED", "邮箱/密码登录已下线，请使用手机号验证码登录");
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { db: AppDb["db"]; jwt: Jwt; authLimiter: AuthLimiter; otp: OtpStore },
) {
  const service = makeAuthService(deps.db, deps.jwt);
  const auth = makeAuth(deps.jwt);

  // 申请验证码：提交手机号（138… / +86138… 均可）
  app.post("/api/v1/auth/request-code", async (req) => {
    const body = requestCodeSchema.parse(req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest("INVALID_PHONE", "请输入有效的中国大陆手机号");
    enforceAuthLimits(deps.authLimiter, req, phone);
    const production = config.authMode === "production";

    const sms = await sendVerifyCode(phone);
    if (sms.sent && sms.code) {
      deps.otp.store(phone, sms.code);
      return { ok: true, ...(production ? {} : { code: sms.code }) };
    }
    if (production) {
      throw new AppError(503, "SMS_SEND_FAILED", "短信发送失败，请稍后重试");
    }
    const code = deps.otp.generate(phone);
    return { ok: true, code };
  });

  // 验证码登录：已有完整账号直接登录；新账号或旧“用户”账号进入强制昵称设置。
  app.post("/api/v1/auth/login-code", async (req) => {
    const body = loginCodeSchema.parse(req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest("INVALID_PHONE", "请输入有效的中国大陆手机号");
    enforceAuthLimits(deps.authLimiter, req, phone);

    const svc = await checkVerifyCode(phone, body.code);
    const local = deps.otp.verify(phone, body.code);
    const svcPass = svc.supported && svc.ok === true;
    const localPass = local.ok;
    if (!svcPass && !localPass) {
      throw badRequest(
        local.reason === "expired" ? "CODE_EXPIRED" : local.reason === "exhausted" ? "CODE_EXHAUSTED" : "INVALID_CODE",
        local.reason === "expired" ? "验证码已过期，请重新获取" : local.reason === "exhausted" ? "验证码错误次数过多，请重新获取" : "验证码错误",
      );
    }

    const result = service.beginLoginByPhone(phone);
    if (result.status === "authenticated") {
      const session = await service.createAuthenticatedSession(result.user);
      return { status: "authenticated", ...session };
    }
    return { status: "nickname_required", onboardingToken: result.onboardingToken, expiresAt: result.expiresAt };
  });

  // 完成昵称设置：一次性 onboarding ticket + 昵称。ticket 认领、昵称写入、默认账本/
  // 默认分类、auth_session 均在 service 的同一数据库事务内完成（失败整体回滚、可重试）。
  app.post("/api/v1/auth/complete-profile", async (req) => {
    const body = completeProfileSchema.parse(req.body);
    const result = await service.completeProfile(body.onboardingToken, body.nickname);
    return { status: "authenticated", ...result };
  });

  app.post("/api/v1/auth/refresh", async (req) => {
    enforceLimiter(deps.authLimiter, clientIp(req));
    const body = z.object({ refreshToken: z.string().min(1) }).parse(req.body);
    return await service.refresh(body.refreshToken);
  });

  app.get("/api/v1/auth/me", { preHandler: auth }, async (req) => {
    return await service.me(getUserId(req));
  });

  // ---------------- 旧邮箱/密码接口（保留路由，统一 410） ----------------
  app.post("/api/v1/auth/register", async () => {
    throw authMethodRemoved();
  });
  app.post("/api/v1/auth/login", async () => {
    throw authMethodRemoved();
  });
  app.post("/api/v1/auth/reset-code", async () => {
    throw authMethodRemoved();
  });
  app.post("/api/v1/auth/reset-password", async () => {
    throw authMethodRemoved();
  });
}
