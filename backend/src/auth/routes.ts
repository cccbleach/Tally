import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import type { Jwt } from "./jwt.js";
import { makeAuthService } from "./service.js";
import { makeAuth, getUserId } from "../middleware/auth.js";
import { seedDefaultCategories } from "../db/seed.js";
import { createDefaultLedger } from "../lib/ledger.js";
import { AppError, badRequest, tooManyRequests, unauthorized } from "../lib/errors.js";
import type { createRateLimiter } from "../lib/rateLimit.js";
import type { OtpStore } from "../lib/otp.js";
import { checkVerifyCode, sendVerifyCode } from "../lib/sms.js";
import { config } from "../config.js";

type AuthLimiter = ReturnType<typeof createRateLimiter>;

function clientIp(req: FastifyRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

function enforceLimiter(limiter: AuthLimiter, req: FastifyRequest) {
  const { allowed } = limiter(clientIp(req));
  if (!allowed) throw tooManyRequests("RATE_LIMITED", "请求过于频繁，请稍后再试");
}

// 账号：邮箱 或 手机号（中国大陆常见格式，可带 +/空格）
const accountValidator = z
  .string()
  .trim()
  .min(3, "请输入邮箱或手机号")
  .refine(
    (v) =>
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ||
      /^\+?[0-9]{6,20}$/.test(v.replace(/\s+/g, "")), // 手机号允许内部空格，归一化由 service 处理
    { message: "请输入有效的邮箱或手机号" },
  );

const registerSchema = z.object({
  email: accountValidator,
  password: z.string().min(8, "密码至少 8 位").max(128, "密码过长"),
  displayName: z.string().max(40, "昵称过长").optional(),
});

const loginSchema = z.object({
  email: accountValidator,
  password: z.string().min(1, "密码不能为空"),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, "刷新令牌不能为空"),
});

const forgotSchema = z.object({
  email: z.string().email("邮箱格式不正确"),
});

const resetSchema = z.object({
  resetToken: z.string().min(1, "重置令牌不能为空"),
  newPassword: z.string().min(8, "密码至少 8 位").max(128, "密码过长"),
});

const requestCodeSchema = z.object({
  email: accountValidator,
});

const loginCodeSchema = z.object({
  email: accountValidator,
  code: z.string().min(4, "验证码长度为 4-8 位").max(8, "验证码长度为 4-8 位"),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { db: AppDb["db"]; jwt: Jwt; authLimiter: AuthLimiter; otp: OtpStore },
) {
  const service = makeAuthService(deps.db, deps.jwt);
  const auth = makeAuth(deps.jwt);

  app.post("/api/v1/auth/register", async (req) => {
    enforceLimiter(deps.authLimiter, req);
    const body = registerSchema.parse(req.body);
    const result = await service.register(body.email, body.password, body.displayName ?? "");
    const ledgerId = createDefaultLedger(deps.db, result.user.id);
    seedDefaultCategories(deps.db, result.user.id, ledgerId);
    return result;
  });

  app.post("/api/v1/auth/login", async (req) => {
    enforceLimiter(deps.authLimiter, req);
    const body = loginSchema.parse(req.body);
    return await service.login(body.email, body.password);
  });

  app.post("/api/v1/auth/refresh", async (req) => {
    enforceLimiter(deps.authLimiter, req);
    const body = refreshSchema.parse(req.body);
    const payload = await deps.jwt.verify(body.refreshToken);
    if (payload.type !== "refresh") throw unauthorized("INVALID_REFRESH_TOKEN", "刷新令牌无效");
    return await service.refresh(payload.sub);
  });

  app.post("/api/v1/auth/request-code", async (req) => {
    enforceLimiter(deps.authLimiter, req);
    const body = requestCodeSchema.parse(req.body);
    const phone = body.email.trim().toLowerCase();
    const production = config.authMode === "production";

    // 生产模式：验证码永不回传、发送失败不降级为明文，只返回通用提示。
    // 开发模式：短信异常时可回退本地生成并回传验证码便于联调。
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

  app.post("/api/v1/auth/login-code", async (req) => {
    enforceLimiter(deps.authLimiter, req);
    const body = loginCodeSchema.parse(req.body);
    const key = body.email.trim().toLowerCase();

    // 校验验证码：优先用短信认证服务端校验；若服务端未通过（如发送失败/降级），再回退本地校验
    const svc = await checkVerifyCode(key, body.code);
    const local = deps.otp.verify(key, body.code);
    const svcPass = svc.supported && svc.ok === true;
    // 无论是否启用短信服务，本地校验都必须通过（未启用时仅本地；启用时也允许本地兜底）
    const localPass = local.ok;
    if (!svcPass && !localPass) {
      throw badRequest(
        local.reason === "expired" ? "CODE_EXPIRED" : local.reason === "exhausted" ? "CODE_EXHAUSTED" : "INVALID_CODE",
        local.reason === "expired" ? "验证码已过期，请重新获取" : local.reason === "exhausted" ? "验证码错误次数过多，请重新获取" : "验证码错误",
      );
    }

    const result = await service.loginPhone(key);
    if (result.created) {
      const ledgerId = createDefaultLedger(deps.db, result.user.id);
      seedDefaultCategories(deps.db, result.user.id, ledgerId);
    }
    return { user: result.user, token: result.token, refreshToken: result.refreshToken };
  });

  app.post("/api/v1/auth/forgot-password", async (req) => {
    const body = forgotSchema.parse(req.body);
    const resetToken = await service.requestReset(body.email);
    // 开发阶段直接返回 resetToken；接入邮件服务后改为“已发送邮件”。
    return { ok: true, resetToken };
  });

  app.post("/api/v1/auth/reset-password", async (req) => {
    const body = resetSchema.parse(req.body);
    await service.resetPassword(body.resetToken, body.newPassword);
    return { ok: true };
  });

  app.get("/api/v1/auth/me", { preHandler: auth }, async (req) => {
    return await service.me(getUserId(req));
  });
}
