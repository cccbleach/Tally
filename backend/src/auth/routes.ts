import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import type { Jwt } from "./jwt.js";
import { makeAuthService } from "./service.js";
import { makeAuth, getUserId } from "../middleware/auth.js";
import { seedDefaultCategories } from "../db/seed.js";
import { createDefaultLedger } from "../lib/ledger.js";
import { tooManyRequests, unauthorized } from "../lib/errors.js";
import type { createRateLimiter } from "../lib/rateLimit.js";

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

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { db: AppDb["db"]; jwt: Jwt; authLimiter: AuthLimiter },
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
