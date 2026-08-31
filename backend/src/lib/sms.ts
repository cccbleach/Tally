// 阿里云短信（Dypnsapi20170525 · SendSmsVerifyCode / CheckSmsVerifyCode）封装。
//
// 号码口径（重要，上线阻断项）：
//   - 内部/数据库/JWT 一律使用 `+86` E.164（如 +8613800000001）。
//   - 调阿里云 SendSmsVerifyCode / CheckSmsVerifyCode 时，请求参数必须是
//     `CountryCode=86` + `PhoneNumber=11 位大陆手机号（不带 +86）`。
//   - `toMainlandPhoneNumber` 是发送与校验共用的统一转换函数。
//
// 可测性：本模块把「请求构造 / 响应解析」拆成纯函数，并通过注入的 client 执行；
// 测试用 mock client 捕获请求参数，不访问真实阿里云、不读取开发机短信配置。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface SmsResult {
  sent: boolean;
  code?: string;
}

export interface VerifyResult {
  supported: boolean; // 是否启用了短信认证（可用时以服务端校验为准）
  ok?: boolean;
}

// ---------- 统一号码转换（发送与校验共用） ----------
// 入参允许内部 E.164（+86138...）或 138.../86 138.../带空格等形式；
// 只接受中国大陆 11 位手机号。返回不带国家码的 11 位号码；非法返回 null。
export function toMainlandPhoneNumber(phone: string): string | null {
  if (!phone) return null;
  const compact = phone.trim().replace(/[\s-]/g, "");
  let digits = compact;
  if (/^\+86/.test(compact)) {
    digits = compact.slice(3);
  } else if (/^86\d{11}$/.test(compact)) {
    digits = compact.slice(2);
  } else if (/^86[ ]\d{11}$/.test(compact)) {
    digits = compact.replace(/^86\s+/, "");
  }
  if (!/^1[3-9]\d{9}$/.test(digits)) return null;
  return digits;
}

// ---------- 请求构造（不含 SDK 类依赖，便于断言与复用） ----------
export function buildSendRequest(phone: string): Record<string, unknown> {
  const phoneNumber = toMainlandPhoneNumber(phone);
  if (!phoneNumber) throw new Error("不是有效的大陆手机号（无法转成 11 位）：" + phone);
  return {
    countryCode: process.env.ALIYUN_SMS_COUNTRY_CODE ?? "86",
    schemeName: process.env.ALIYUN_SMS_SCHEME_NAME ?? "Tally",
    phoneNumber,
    signName: process.env.ALIYUN_SMS_SIGN_NAME ?? "",
    templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE ?? "100001",
    templateParam: JSON.stringify({ code: "##code##", min: 10 }),
    returnVerifyCode: true, // 服务端返回明文验证码，便于本地核验
  };
}

export function buildCheckRequest(phone: string, code: string): Record<string, unknown> {
  const phoneNumber = toMainlandPhoneNumber(phone);
  if (!phoneNumber) throw new Error("不是有效的大陆手机号（无法转成 11 位）：" + phone);
  return {
    countryCode: process.env.ALIYUN_SMS_COUNTRY_CODE ?? "86",
    phoneNumber,
    schemeName: process.env.ALIYUN_SMS_SCHEME_NAME ?? "Tally",
    verifyCode: code,
  };
}

// ---------- 响应解析（供生产与 mock 共用） ----------
function sanitizeSmsBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const key of ["phoneNumber", "phone", "verifyCode"]) {
    if (out[key] !== undefined) out[key] = "****";
  }
  if (out.model && typeof out.model === "object") {
    out.model = sanitizeSmsBody(out.model);
  }
  return out;
}

function bodyOf(resp: unknown): { body?: { success?: boolean; model?: { verifyCode?: string; verifyResult?: string } } } {
  return (resp ?? {}) as { body?: { success?: boolean; model?: { verifyCode?: string; verifyResult?: string } } };
}

export function parseSendResponse(resp: unknown): SmsResult {
  const body = bodyOf(resp).body;
  const sentCode = body?.model?.verifyCode;
  if (!body || body.success === false || !sentCode) {
    console.error("[sms] 阿里云返回发送失败（已脱敏）:", JSON.stringify(sanitizeSmsBody(body ?? {})));
    return { sent: false };
  }
  console.log("[sms] 阿里云短信发送成功（敏感信息不落日志）");
  return { sent: true, code: sentCode };
}

export function parseCheckResponse(resp: unknown): VerifyResult {
  const body = bodyOf(resp).body;
  const pass = body?.success === true && body?.model?.verifyResult === "PASS";
  console.log("[sms] 校验验证码（已脱敏）:", JSON.stringify(sanitizeSmsBody(body ?? {})));
  return { supported: true, ok: pass };
}

// ---------- 可注入 client（测试用 mock，不触真实阿里云） ----------
export interface SmsClientLike {
  sendSmsVerifyCodeWithOptions(req: unknown, runtime: unknown): Promise<unknown>;
  checkSmsVerifyCodeWithOptions(req: unknown, runtime: unknown): Promise<unknown>;
}

export async function executeSendVerifyCode(client: SmsClientLike, phone: string): Promise<SmsResult> {
  // 使用统一转换构造请求；mock 与生产都走同一份代码。
  const req = buildSendRequest(phone);
  const resp = await client.sendSmsVerifyCodeWithOptions(req, {});
  return parseSendResponse(resp);
}

export async function executeCheckVerifyCode(client: SmsClientLike, phone: string, code: string): Promise<VerifyResult> {
  const req = buildCheckRequest(phone, code);
  const resp = await client.checkSmsVerifyCodeWithOptions(req, {});
  return parseCheckResponse(resp);
}

// ---------- 生产路径 ----------

// 统一的阿里云短信凭据初始化函数：SendSmsVerifyCode 与 CheckSmsVerifyCode 共用。
// 每次调用都独立地把 ALIYUN_* 或 ALIBABA_CLOUD_* 解析并归一化到阿里云 SDK 默认环境变量
// （ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET），
// 因此不依赖「发送接口曾在同一进程先运行过」，只提供 ALIYUN_* 或只提供 ALIBABA_CLOUD_* 均可。
export interface SmsCredentials {
  ak: string;
  sk: string;
  present: boolean;
}

export function resolveSmsCredentials(): SmsCredentials {
  const ak = process.env.ALIYUN_ACCESS_KEY_ID ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_ID ?? "";
  const sk = process.env.ALIYUN_ACCESS_KEY_SECRET ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET ?? "";
  if (ak && sk) {
    // 归一化到阿里云 SDK 默认凭据环境变量：任何调用顺序下 SDK 都能读到
    process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = ak;
    process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = sk;
  }
  return { ak, sk, present: !!(ak && sk) };
}

function enabled(): boolean {
  return (
    (process.env.ALIYUN_SMS_ENABLED === "true" || process.env.ALIYUN_SMS_ENABLED === "1") &&
    resolveSmsCredentials().present
  );
}

function createRealClient(): SmsClientLike {
  const OpenApi = require("@alicloud/openapi-client");
  const DypnMod = require("@alicloud/dypnsapi20170525");
  const Dypnsapi = DypnMod.default;
  const Credential = require("@alicloud/credentials").default;
  const config = new OpenApi.Config({ credential: new Credential() });
  config.endpoint = "dypnsapi.aliyuncs.com";
  return new Dypnsapi(config) as SmsClientLike;
}

export interface SmsCallOptions {
  /** 测试注入用 mock client；缺省时使用真实阿里云 client */
  client?: SmsClientLike;
}

function pickClient(options?: SmsCallOptions): SmsClientLike {
  return options?.client ?? createRealClient();
}

export async function sendVerifyCode(phone: string, options?: SmsCallOptions): Promise<SmsResult> {
  // 每次调用都先走统一凭据初始化（仅 ALIYUN_* 时也能独立工作）
  if (!enabled()) return { sent: false };
  try {
    const DypnMod = require("@alicloud/dypnsapi20170525");
    const { RuntimeOptions } = require("@alicloud/tea-util");
    const client = pickClient(options);
    const req = new DypnMod.SendSmsVerifyCodeRequest(buildSendRequest(phone));
    const resp = await client.sendSmsVerifyCodeWithOptions(req, new RuntimeOptions({}));
    return parseSendResponse(resp);
  } catch (e: any) {
    console.error("[sms] 短信发送失败:", e?.message ?? e);
    return { sent: false };
  }
}

export async function checkVerifyCode(phone: string, code: string, options?: SmsCallOptions): Promise<VerifyResult> {
  // 每次调用都先走统一凭据初始化（仅 ALIYUN_* 时也能独立工作）
  if (!enabled()) return { supported: false };
  try {
    const DypnMod = require("@alicloud/dypnsapi20170525");
    const { RuntimeOptions } = require("@alicloud/tea-util");
    const client = pickClient(options);
    const req = new DypnMod.CheckSmsVerifyCodeRequest(buildCheckRequest(phone, code));
    const resp = await client.checkSmsVerifyCodeWithOptions(req, new RuntimeOptions({}));
    return parseCheckResponse(resp);
  } catch (e: any) {
    console.error("[sms] 校验失败，回退本地校验:", e?.message ?? e);
    return { supported: false };
  }
}
