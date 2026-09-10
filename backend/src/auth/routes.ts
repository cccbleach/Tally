import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import type { Jwt } from "./jwt.js";
import { makeAuthService } from "./service.js";
import { makeAuth, getUserId } from "../middleware/auth.js";
import { AppError, badRequest, tooManyRequests } from "../lib/errors.js";
import type { OtpStore } from "../lib/otp.js";
import { checkVerifyCode, isSmsLive, sendVerifyCode } from "../lib/sms.js";
import { createRateLimiter } from "../lib/rateLimit.js";
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

// ---------- 短信节流（号码级冷却 + 号码日配额 + 全局日预算） ----------
// 历史缺陷：request-code 只受「IP 60/min + 号码 60/min」限制，没有冷却、没有日上限、
// 也没有全局预算（单 IP 理论可触发约 8.6 万条/天短信：轰炸 + 费用失控）。
export interface SmsThrottleOptions {
  /** 同一号码两次申请的最小间隔（默认 60 秒） */
  cooldownMs?: number;
  /** 同一号码每日发送上限（默认 5 次） */
  perNumberDaily?: number;
  /** 全局每日发送总量上限（默认 2000 条） */
  globalDaily?: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_PER_NUMBER_DAILY = 5;
const DEFAULT_GLOBAL_DAILY = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

const retryAfterSeconds = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));

function makeSmsThrottle(opts?: SmsThrottleOptions) {
  const cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const perNumberDaily = opts?.perNumberDaily ?? DEFAULT_PER_NUMBER_DAILY;
  const globalDaily = opts?.globalDaily ?? DEFAULT_GLOBAL_DAILY;
  const cooldown = createRateLimiter({ windowMs: cooldownMs, max: 1 });
  const daily = createRateLimiter({ windowMs: DAY_MS, max: perNumberDaily });
  const global = createRateLimiter({ windowMs: DAY_MS, max: globalDaily });

  return {
    // 顺序：冷却 → 号码日限 → 全局预算；命中即 429 并带 Retry-After
    check(phone: string, reply: { header(k: string, v: string): unknown }) {
      const deny = (code: string, message: string, windowMs: number) => {
        void reply.header("retry-after", retryAfterSeconds(windowMs));
        throw tooManyRequests(code, message);
      };
      if (!cooldown("send:cooldown:" + phone).allowed) {
        deny("SMS_COOLDOWN", `请求过于频繁，请 ${retryAfterSeconds(cooldownMs)} 秒后再试`, cooldownMs);
      }
      if (!daily("send:daily:" + phone).allowed) {
        deny("SMS_DAILY_LIMIT", "该手机号今日验证码次数已达上限，请明天再试", DAY_MS);
      }
      if (!global("send:global").allowed) {
        deny("SMS_GLOBAL_DAILY_LIMIT", "短信发送量已达今日上限，请稍后再试", DAY_MS);
      }
    },
    // 真实外呼失败时归还号码日配额与全局预算（冷却窗口保留，防止被用来反复触发发送尝试）
    refund(phone: string) {
      daily.refund("send:daily:" + phone);
      global.refund("send:global");
    },
  };
}

// 短信适配器：把"是否具备真实外呼能力"与"发送/校验"抽成可注入依赖，
// 便于在测试中确定性地驱动节流与校验逻辑，且不触网。
export interface SmsAdapter {
  isLive(): boolean;
  send(phone: string): Promise<{ sent: boolean; code?: string }>;
  check(phone: string, code: string): Promise<{ supported: boolean; ok?: boolean }>;
}

const defaultSmsAdapter: SmsAdapter = {
  isLive: isSmsLive,
  send: (phone) => sendVerifyCode(phone),
  check: (phone, code) => checkVerifyCode(phone, code),
};

export interface AuthRouteDeps {
  db: AppDb["db"];
  jwt: Jwt;
  /** 申请验证码专用限流桶（与 login-code 分开，避免互相消耗额度） */
  requestCodeLimiter: AuthLimiter;
  /** 验证码登录专用限流桶 */
  loginCodeLimiter: AuthLimiter;
  otp: OtpStore;
  /** 短信发送/校验适配器（可注入，便于确定性测试且不触网） */
  sms?: SmsAdapter;
  /** 号码级/全局短信节流参数 */
  smsThrottle?: SmsThrottleOptions;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps) {
  const service = makeAuthService(deps.db, deps.jwt);
  const auth = makeAuth(deps.jwt);
  const smsAdapter = deps.sms ?? defaultSmsAdapter;
  const smsThrottle = makeSmsThrottle(deps.smsThrottle);

  // 申请验证码：提交手机号（138… / +86138… 均可）
  app.post("/api/v1/auth/request-code", async (req, reply) => {
    const body = requestCodeSchema.parse(req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest("INVALID_PHONE", "请输入有效的中国大陆手机号");
    enforceAuthLimits(deps.requestCodeLimiter, req, phone);
    // 双保险：即使 config 的互锁被绕过（例如有人改回无校验的强制类型转换），
    // 只要进程运行在生产环境，就绝不以任何形式把验证码回传给请求方。
    const production = config.isProduction || config.authMode === "production";

    // 号码级冷却/日配额 + 全局日预算：仅在会真实外呼短信时生效。
    // 开发/测试（ALIYUN_SMS_ENABLED=false）无外呼成本，保持"验证码回传"的既有联调语义，
    // 也不会让同一手机号在测试中连续两次申请被冷却挡住。
    const willSendRealSms = smsAdapter.isLive();
    if (willSendRealSms) {
      smsThrottle.check(phone, reply);
    }

    const sms = await smsAdapter.send(phone);
    if (sms.sent && sms.code) {
      deps.otp.store(phone, sms.code);
      return { ok: true, ...(production ? {} : { code: sms.code }) };
    }
    // 真实外呼失败：把刚占用的配额还回去，避免"发送失败还扣额度"误伤用户
    if (willSendRealSms) {
      smsThrottle.refund(phone);
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
    enforceAuthLimits(deps.loginCodeLimiter, req, phone);

    const svc = await smsAdapter.check(phone, body.code);
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
    enforceLimiter(deps.loginCodeLimiter, clientIp(req));
    const body = z.object({ refreshToken: z.string().min(1) }).parse(req.body);
    return await service.refresh(body.refreshToken);
  });

  app.get("/api/v1/auth/me", { preHandler: auth }, async (req) => {
    return await service.me(getUserId(req));
  });

  // 服务端登出（当前设备）：吊销请求携带的 refreshToken 所对应的会话。
  // 幂等：令牌缺失/已吊销/不属于该用户都返回 ok=true revoked=false，
  // 避免把"登出"变成可用于探测令牌有效性的接口。
  // access token 在其 15 分钟有效期内仍可用（无状态 JWT 的固有语义），
  // 但攻击者无法再用该 refresh token 换取新令牌。
  app.post("/api/v1/auth/logout", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = z.object({ refreshToken: z.string().min(1).optional() }).parse(req.body ?? {});
    const revoked = body.refreshToken ? service.revokeSessionByRefreshToken(userId, body.refreshToken) : false;
    return { ok: true, revoked };
  });

  // 退出全部设备：吊销该用户所有仍有效的会话（令牌可能已在别处泄漏时的兜底手段）
  app.post("/api/v1/auth/logout-all", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const revoked = service.revokeAllSessions(userId);
    return { ok: true, revoked };
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
