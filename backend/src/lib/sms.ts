// 阿里云短信（Dypnsapi20170525 · SendSmsVerifyCode）封装。
// 未配置/发送失败时返回 { sent: false }，调用方回退为“直接把验证码返回给客户端”（开发/降级模式）。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface SmsResult {
  sent: boolean;
  code?: string;
}

function enabled(): boolean {
  return (
    (process.env.ALIYUN_SMS_ENABLED === "true" || process.env.ALIYUN_SMS_ENABLED === "1") &&
    !!(process.env.ALIYUN_ACCESS_KEY_ID ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_ID) &&
    !!(process.env.ALIYUN_ACCESS_KEY_SECRET ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET)
  );
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
    // 业务失败（签名/模板无效、频率限制、欠费等）：视为未发送，走降级
    if (!body || body.success === false || !body.verifyCode) {
      console.error("[sms] 阿里云返回发送失败:", JSON.stringify(body ?? {}));
      return { sent: false };
    }
    console.log("[sms] 阿里云短信发送成功, verifyCode:", body.verifyCode);
    return { sent: true, code: body.verifyCode };
  } catch (e: any) {
    console.error("[sms] 发送失败，降级为开发模式回传验证码:", e?.message ?? e);
    return { sent: false };
  }
}
