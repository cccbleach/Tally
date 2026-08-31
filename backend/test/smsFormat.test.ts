import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toMainlandPhoneNumber,
  buildSendRequest,
  buildCheckRequest,
  executeSendVerifyCode,
  executeCheckVerifyCode,
  parseSendResponse,
  parseCheckResponse,
  checkVerifyCode,
  resolveSmsCredentials,
} from "../src/lib/sms.js";
import { normalizePhone } from "../src/lib/phone.js";

// 回归：上线阻断项——阿里云短信参数格式。
// 内部存 +86 E.164；出站必须 CountryCode=86 + PhoneNumber=不带国家码的 11 位。
// 全部用 mock SDK 捕获，不访问真实阿里云、不读开发机真实短信配置。
process.env.ALIYUN_SMS_ENABLED = "false";

test("统一转换 toMainlandPhoneNumber：+86/裸号/空格/86 前缀 → 不带国家码 11 位", () => {
  assert.equal(toMainlandPhoneNumber("+8613800000001"), "13800000001");
  assert.equal(toMainlandPhoneNumber("13800000001"), "13800000001");
  assert.equal(toMainlandPhoneNumber("+86 138 0000 0001"), "13800000001");
  assert.equal(toMainlandPhoneNumber("86 13800000001"), "13800000001");
  assert.equal(toMainlandPhoneNumber("8613800000001"), "13800000001");
  assert.equal(toMainlandPhoneNumber("138-0000-0001"), "13800000001");
  // 非法：不足 11 位 / 非 1[3-9] 开头 / 邮箱
  assert.equal(toMainlandPhoneNumber("12345"), null);
  assert.equal(toMainlandPhoneNumber("12300000000"), null);
  assert.equal(toMainlandPhoneNumber("a@b.com"), null);
});

test("内部仍用 +86 E.164，出站统一转 11 位（发送与校验同一转换）", () => {
  const internal = normalizePhone("+86 138 0000 0001")!;
  assert.equal(internal, "+8613800000001", "内部存储必须为 +86 E.164");
  // 发送与校验共用同一转换函数
  assert.equal(toMainlandPhoneNumber(internal), "13800000001");
});

test("mock SDK 捕获发送参数：CountryCode=86 且 PhoneNumber 不带 +86（无真实网络/配置）", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const mockClient = {
    async sendSmsVerifyCodeWithOptions(req: Record<string, unknown>) {
      captured.push(req);
      return { body: { success: true, model: { verifyCode: "123456" } } };
    },
    async checkSmsVerifyCodeWithOptions() {
      throw new Error("不应走到校验");
    },
  };

  const res = await executeSendVerifyCode(mockClient as never, "+8613800000001");
  assert.equal(res.sent, true);
  assert.equal(res.code, "123456");
  assert.equal(captured.length, 1);
  const req = captured[0]!;
  assert.equal(req.countryCode, "86");
  assert.equal(req.phoneNumber, "13800000001");
  assert.ok(!String(req.phoneNumber).includes("+"), "PhoneNumber 不得带 +");
  assert.match(String(req.phoneNumber), /^1[3-9]\d{9}$/, "PhoneNumber 应为 11 位大陆手机号");
});

test("mock SDK 捕获校验参数：CountryCode=86 且 PhoneNumber 不带 +86", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const mockClient = {
    async sendSmsVerifyCodeWithOptions() {
      throw new Error("不应走到发送");
    },
    async checkSmsVerifyCodeWithOptions(req: Record<string, unknown>) {
      captured.push(req);
      return { body: { success: true, model: { verifyResult: "PASS" } } };
    },
  };
  const res = await executeCheckVerifyCode(mockClient as never, "+8613800000001", "123456");
  assert.equal(res.supported, true);
  assert.equal(res.ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.countryCode, "86");
  assert.equal(captured[0]!.phoneNumber, "13800000001");
  assert.equal(captured[0]!.verifyCode, "123456");
});

test("响应解析（发送失败 / 校验失败）语义正确", () => {
  const okSend = parseSendResponse({ body: { success: true, model: { verifyCode: "888888" } } });
  assert.equal(okSend.sent, true);
  assert.equal(okSend.code, "888888");

  const failSend = parseSendResponse({ body: { success: false, message: "isv.SMS_SIGNATURE_ILLEGAL" } });
  assert.equal(failSend.sent, false);

  const passCheck = parseCheckResponse({ body: { success: true, model: { verifyResult: "PASS" } } });
  assert.deepEqual(passCheck, { supported: true, ok: true });
  const failCheck = parseCheckResponse({ body: { success: true, model: { verifyResult: "FAIL" } } });
  assert.deepEqual(failCheck, { supported: true, ok: false });
});

test("buildSendRequest / buildCheckRequest 也走同一转换（非法号码抛错）", () => {
  assert.throws(() => buildSendRequest("12345"), /不是有效的大陆手机号/);
  assert.throws(() => buildCheckRequest("1234567890", "123456"), /不是有效的大陆手机号/);
});

test("仅 ALIYUN_* 环境变量时独立执行 CheckSmsVerifyCode（mock，不依赖发送接口先运行）", async () => {
  // 保存并清空现有短信环境变量，确保本场景只暴露 ALIYUN_*（不含 ALIBABA_CLOUD_*）
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "ALIYUN_SMS_ENABLED",
    "ALIYUN_ACCESS_KEY_ID",
    "ALIYUN_ACCESS_KEY_SECRET",
    "ALIBABA_CLOUD_ACCESS_KEY_ID",
    "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
  ];
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    // 只提供 ALIYUN_* 变量，ALIBABA_CLOUD_* 完全缺失
    process.env.ALIYUN_SMS_ENABLED = "true";
    process.env.ALIYUN_ACCESS_KEY_ID = "aliyun-test-ak";
    process.env.ALIYUN_ACCESS_KEY_SECRET = "aliyun-test-sk";

    // 独立执行 CheckSmsVerifyCode 生产路径（不经 Send），注入 mock client 不触真实网络
    const captured: Array<Record<string, unknown>> = [];
    const mockClient = {
      async sendSmsVerifyCodeWithOptions() {
        throw new Error("不应走到发送");
      },
      async checkSmsVerifyCodeWithOptions(req: Record<string, unknown>) {
        captured.push(req);
        return { body: { success: true, model: { verifyResult: "PASS" } } };
      },
    };
    const res = await checkVerifyCode("+8613800000001", "123456", { client: mockClient as never });
    assert.deepEqual(res, { supported: true, ok: true }, "仅 ALIYUN_* 时应能启用并完成校验");
    assert.equal(captured.length, 1, "应恰好执行一次 Check");
    assert.equal(captured[0]!.phoneNumber, "13800000001");
    assert.equal(captured[0]!.verifyCode, "123456");

    // 统一凭据初始化应已把 ALIYUN_* 归一化到 SDK 默认环境变量（无需发送接口先运行）
    assert.equal(process.env.ALIBABA_CLOUD_ACCESS_KEY_ID, "aliyun-test-ak");
    assert.equal(process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, "aliyun-test-sk");
    assert.deepEqual(resolveSmsCredentials(), { ak: "aliyun-test-ak", sk: "aliyun-test-sk", present: true });
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
