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

// 找回密码验证码与登录验证码相互隔离的 OTP 命名空间前缀
const RESET_OTP_PREFIX = "reset:";

// 账号归一化（与 service 保持一致）：邮箱统一小写，手机号去掉内部空格
function normalizeAccount(account: string): string {
  const t = account.trim();
  if (t.includes("@")) return t.toLowerCase();
  return t.replace(/\s+/g, "");
}

function clientIp(req: FastifyRequest): string {
  // 默认（TRUST_PROXY=0）不信任客户端提交的 X-Forwarded-For，只信 TCP 对端地址。
  // 仅在显式配置可信代理层数后才取 XFF。
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
      // 标准约定：每个受信代理都会把自己的“上一跳来源”追加到 XFF 最右侧。
      // 因此配置了 N 个可信代理时，真实客户端 IP 是从右往左数第 N 个地址；
      // 更左侧的地址可能由客户端伪造，不能固定采用最左侧。
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

// 认证类接口同时做 IP 维度与账号维度限流。
function enforceAuthLimits(limiter: AuthLimiter, req: FastifyRequest, account?: string) {
  enforceLimiter(limiter, "ip:" + clientIp(req));
  if (account) enforceLimiter(limiter, "account:" + account.trim().toLowerCase());
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

// 找回流程：先申请短信验证码，再用验证码直接设置新密码。
// 两步都必须真实投递短信；生产环境发不出去就返回 503，绝不返回“成功但拿不到验证码”。
// account 允许提交邮箱（与注册口径一致），但邮箱会在处理函数里被明确拒绝：
// 项目未接入 SMTP，邮箱没有任何可用的凭证投递通道。
const resetCodeSchema = z.object({
  account: accountValidator,
});

const resetSchema = z.object({
  account: accountValidator,
  code: z.string().min(4, "验证码长度为 4-8 位").max(8, "验证码长度为 4-8 位"),
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
    enforceAuthLimits(deps.authLimiter, req, "register");
    const body = registerSchema.parse(req.body);
    const result = await service.register(body.email, body.password, body.displayName ?? "");
    const ledgerId = createDefaultLedger(deps.db, result.user.id);
    seedDefaultCategories(deps.db, result.user.id, ledgerId);
    return result;
  });

  app.post("/api/v1/auth/login", async (req) => {
    const body = loginSchema.parse(req.body);
    enforceAuthLimits(deps.authLimiter, req, body.email);
    return await service.login(body.email, body.password);
  });

  app.post("/api/v1/auth/refresh", async (req) => {
    enforceLimiter(deps.authLimiter, clientIp(req));
    const body = refreshSchema.parse(req.body);
    return await service.refresh(body.refreshToken);
  });

  app.post("/api/v1/auth/request-code", async (req) => {
    const body = requestCodeSchema.parse(req.body);
    const phone = body.email.trim().toLowerCase();
    enforceAuthLimits(deps.authLimiter, req, phone);
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
    const body = loginCodeSchema.parse(req.body);
    const key = body.email.trim().toLowerCase();
    enforceAuthLimits(deps.authLimiter, req, key);

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

  // 申请找回密码验证码（短信投递）。与「验证码登录」使用不同 OTP 命名空间，
  // 登录验证码不能用来改密码，反之亦然。
  app.post("/api/v1/auth/reset-code", async (req) => {
    const body = resetCodeSchema.parse(req.body);
    const phone = normalizeAccount(body.account);
    enforceAuthLimits(deps.authLimiter, req, phone);
    const production = config.authMode === "production";

    // 邮箱账号没有可投递通道 → 明确拒绝，而不是假装已发送。
    if (phone.includes("@")) {
      throw badRequest(
        "EMAIL_RECOVERY_UNAVAILABLE",
        "找回密码仅支持手机号（短信投递）；邮箱账号未接入邮件通道，请使用手机号账号或联系管理员人工重置",
      );
    }
    // 账号不存在 → 明确报错（不能返回“成功”，否则用户永远等不到验证码）。
    if (!service.accountExists(phone)) {
      throw new AppError(404, "ACCOUNT_NOT_FOUND", "该手机号未注册");
    }

    const sms = await sendVerifyCode(phone);
    if (sms.sent && sms.code) {
      deps.otp.store(RESET_OTP_PREFIX + phone, sms.code);
      return { ok: true, ...(production ? {} : { code: sms.code }) };
    }
    // 生产模式：短信发不出去就是失败（503），既不回传验证码也不降级为“已受理”。
    if (production) {
      throw new AppError(503, "SMS_SEND_FAILED", "短信发送失败，请稍后重试");
    }
    // 开发模式：本地生成并回传验证码，便于无短信环境下联调。
    const code = deps.otp.generate(RESET_OTP_PREFIX + phone);
    return { ok: true, code };
  });

  // 用短信验证码直接设置新密码：证明手机号所有权即可恢复账号，无需邮件 reset token。
  // 成功后旧密码失效并吊销全部会话（其它设备需重新登录）。
  app.post("/api/v1/auth/reset-password", async (req) => {
    const body = resetSchema.parse(req.body);
    const phone = normalizeAccount(body.account);
    enforceAuthLimits(deps.authLimiter, req, phone);

    // 邮箱账号没有可投递通道，也不可能有找回验证码 → 直接给出可执行的错误提示。
    if (phone.includes("@")) {
      throw badRequest(
        "EMAIL_RECOVERY_UNAVAILABLE",
        "找回密码仅支持手机号（短信投递）；邮箱账号未接入邮件通道，请使用手机号账号或联系管理员人工重置",
      );
    }

    // 与登录验证码一致：优先短信服务端校验；未启用/异常时回退本地校验
    //（本地过期时间与尝试次数限制始终生效）。
    const svc = await checkVerifyCode(phone, body.code);
    const local = deps.otp.verify(RESET_OTP_PREFIX + phone, body.code);
    if ((svc.supported && svc.ok !== true) || !local.ok) {
      throw badRequest(
        local.reason === "expired" ? "CODE_EXPIRED" : local.reason === "exhausted" ? "CODE_EXHAUSTED" : "INVALID_CODE",
        local.reason === "expired" ? "验证码已过期，请重新获取" : local.reason === "exhausted" ? "验证码错误次数过多，请重新获取" : "验证码错误",
      );
    }

    await service.setPasswordBySms(phone, body.newPassword);
    return { ok: true };
  });

  app.get("/api/v1/auth/me", { preHandler: auth }, async (req) => {
    return await service.me(getUserId(req));
  });
}
