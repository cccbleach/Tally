// 阿里云短信（Dypnsapi20170525 · SendSmsVerifyCode）封装。
// 未配置/发送失败时返回 { sent: false }，调用方回退为“直接把验证码返回给客户端”（开发/降级模式）。
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

function enabled(): boolean {
  return (
    (process.env.ALIYUN_SMS_ENABLED === "true" || process.env.ALIYUN_SMS_ENABLED === "1") &&
    !!(process.env.ALIYUN_ACCESS_KEY_ID ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_ID) &&
    !!(process.env.ALIYUN_ACCESS_KEY_SECRET ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET)
  );
}

// 供应商响应体脱敏：把手机号与明文验证码都视为个人信息（PII）一并遮蔽，
// 其余（success/requestId/code/message/verifyResult 等）保留以便排障。
// 遮蔽字段：phoneNumber / phone / verifyCode 及其在 model 下的同名嵌套字段。
// 统一用“****”替代，确保日志既不出现手机号也不出现验证码明文。
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

// 短信认证服务由服务端生成验证码；我们通过 returnVerifyCode 取回并在本地校验。
export async function sendVerifyCode(phone: string): Promise<SmsResult> {
  if (!enabled()) return { sent: false };

  // 统一凭据来源到阿里云默认环境变量
  const ak = process.env.ALIYUN_ACCESS_KEY_ID ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const sk = process.env.ALIYUN_ACCESS_KEY_SECRET ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  if (ak) process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = ak;
  if (sk) process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = sk;

  try {
    const OpenApi = require("@alicloud/openapi-client");
    const DypnMod = require("@alicloud/dypnsapi20170525");
    const Dypnsapi = DypnMod.default;
    const SendSmsVerifyCodeRequest = DypnMod.SendSmsVerifyCodeRequest;
    const Credential = require("@alicloud/credentials").default;
    const { RuntimeOptions } = require("@alicloud/tea-util");

    const config = new OpenApi.Config({ credential: new Credential() });
    config.endpoint = "dypnsapi.aliyuncs.com";
    const client = new Dypnsapi(config);

    // 按阿里云规范：TemplateParam 为 JSON 字符串，code 用 ##code## 占位（由服务端生成），min 为有效分钟数
    const req = new SendSmsVerifyCodeRequest({
      countryCode: process.env.ALIYUN_SMS_COUNTRY_CODE ?? "86",
      schemeName: process.env.ALIYUN_SMS_SCHEME_NAME ?? "Tally",
      phoneNumber: phone.includes("+") ? phone.replace("+", "") : phone,
      signName: process.env.ALIYUN_SMS_SIGN_NAME ?? "",
      templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE ?? "100001",
      templateParam: JSON.stringify({ code: "##code##", min: 10 }),
      returnVerifyCode: true, // 在响应中返回明文验证码，便于本地核验
    });
    const resp = await client.sendSmsVerifyCodeWithOptions(req, new RuntimeOptions({}));
    const body = resp?.body;
    const sentCode = body?.model?.verifyCode;
    // 业务失败（签名/模板无效、频率限制、欠费等）视为未发送；成功则取服务端生成的验证码
    if (!body || body.success === false || !sentCode) {
      console.error("[sms] 阿里云返回发送失败（已脱敏）:", JSON.stringify(sanitizeSmsBody(body ?? {})));
      return { sent: false };
    }
    console.log("[sms] 阿里云短信发送成功（敏感信息不落日志）");
    return { sent: true, code: sentCode };
  } catch (e: any) {
    console.error("[sms] 短信发送失败:", e?.message ?? e);
    return { sent: false };
  }
}

// 服务端校验验证码（CheckSmsVerifyCode）。未启用时返回 { supported: false }，由调用方回退到本地校验。
export async function checkVerifyCode(phone: string, code: string): Promise<VerifyResult> {
  if (!enabled()) return { supported: false };
  try {
    const OpenApi = require("@alicloud/openapi-client");
    const DypnMod = require("@alicloud/dypnsapi20170525");
    const Dypnsapi = DypnMod.default;
    const CheckSmsVerifyCodeRequest = DypnMod.CheckSmsVerifyCodeRequest;
    const Credential = require("@alicloud/credentials").default;
    const { RuntimeOptions } = require("@alicloud/tea-util");

    const ak = process.env.ALIYUN_ACCESS_KEY_ID ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
    const sk = process.env.ALIYUN_ACCESS_KEY_SECRET ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
    if (ak) process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = ak;
    if (sk) process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = sk;

    const config = new OpenApi.Config({ credential: new Credential() });
    config.endpoint = "dypnsapi.aliyuncs.com";
    const client = new Dypnsapi(config);

    const req = new CheckSmsVerifyCodeRequest({
      countryCode: process.env.ALIYUN_SMS_COUNTRY_CODE ?? "86",
      phoneNumber: phone.includes("+") ? phone.replace("+", "") : phone,
      schemeName: process.env.ALIYUN_SMS_SCHEME_NAME ?? "Tally",
      verifyCode: code,
    });
    const resp = await client.checkSmsVerifyCodeWithOptions(req, new RuntimeOptions({}));
    const body = resp?.body;
    const pass = body?.success === true && body?.model?.verifyResult === "PASS";
    console.log("[sms] 校验验证码（已脱敏）:", JSON.stringify(sanitizeSmsBody(body ?? {})));
    return { supported: true, ok: pass };
  } catch (e: any) {
    console.error("[sms] 校验失败，回退本地校验:", e?.message ?? e);
    return { supported: false };
  }
}
