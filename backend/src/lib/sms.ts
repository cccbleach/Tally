// 阿里云短信（Dypnsapi20170525 · SendSmsVerifyCode）封装。
// 未配置/发送失败时返回 { sent: false }，调用方回退为“直接把验证码返回给客户端”（开发/降级模式）。

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

export async function sendVerifyCode(phone: string, code: string): Promise<SmsResult> {
  if (!enabled()) return { sent: false };

  // 统一凭据来源到阿里云默认环境变量
  const ak = process.env.ALIYUN_ACCESS_KEY_ID ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const sk = process.env.ALIYUN_ACCESS_KEY_SECRET ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  if (ak) process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = ak;
  if (sk) process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = sk;

  try {
    const Dypnsapi: any = (await import("@alicloud/dypnsapi20170525")).default;
    const OpenApi: any = (await import("@alicloud/openapi-client")).default;
    const Credential: any = (await import("@alicloud/credentials")).default;
    const Util: any = (await import("@alicloud/tea-util")).default;

    const config = new OpenApi.Config({ credential: new Credential() });
    config.endpoint = "dypnsapi.aliyuncs.com";
    const client = new Dypnsapi(config);

    const req = new Dypnsapi.SendSmsVerifyCodeRequest({
      countryCode: process.env.ALIYUN_SMS_COUNTRY_CODE ?? "86",
      schemeName: process.env.ALIYUN_SMS_SCHEME_NAME ?? "Tally",
      phoneNumber: phone.includes("+") ? phone.replace("+", "") : phone,
      signName: process.env.ALIYUN_SMS_SIGN_NAME ?? "Tally",
      templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE ?? "100001",
      templateParam: JSON.stringify({ code, min: "5" }),
      returnVerifyCode: true,
    });
    const resp = await client.sendSmsVerifyCodeWithOptions(req, new Util.RuntimeOptions({}));
    // 阿里云返回 verifyCode 时以它为准（通常与我们传入的一致）
    const sentCode = resp?.body?.verifyCode ?? code;
    console.log("[sms] 阿里云短信发送结果:", JSON.stringify(resp?.body ?? {}));
    return { sent: true, code: sentCode };
  } catch (e: any) {
    console.error("[sms] 发送失败，降级为开发模式回传验证码:", e?.message ?? e);
    return { sent: false };
  }
}
