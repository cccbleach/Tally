process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import type { SmsAdapter } from "../src/auth/routes.js";

// 短信节流回归（Phase 1）：
// 历史缺陷：request-code 只有「IP 60/min + 号码 60/min」，没有号码级冷却、没有日上限、
// 没有全局预算（单 IP 理论 ≈8.6 万条/天），且 request-code 与 login-code 共用一个
// limiter 实例互相消耗额度。
//
// 这里用注入的 SmsAdapter（isLive()=true）确定性地驱动"会真实外呼"的分支，不触网。
let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;

const CANDIDATE_CODE = "246810";

function liveAdapter(opts: { fail?: boolean } = {}): SmsAdapter {
  return {
    isLive: () => true,
    async send() {
      return opts.fail ? { sent: false } : { sent: true, code: CANDIDATE_CODE };
    },
    async check() {
      return { supported: false };
    },
  };
}

async function makeApp(opts: { adapter?: SmsAdapter; throttle?: { cooldownMs?: number; perNumberDaily?: number; globalDaily?: number } } = {}) {
  return await buildApp({
    db,
    jwtSecret: "sms-throttle-secret-0123456789",
    sms: opts.adapter ?? liveAdapter(),
    smsThrottle: opts.throttle,
  });
}

function requestCode(target: FastifyInstance, phone: string) {
  return target.inject({
    method: "POST",
    url: "/api/v1/auth/request-code",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ phone }),
  });
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "tally-sms-throttle-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("号码级冷却：同一手机号在冷却窗口内第二次申请返回 429 SMS_COOLDOWN + Retry-After", async () => {
  const target = await makeApp({ throttle: { cooldownMs: 60_000, perNumberDaily: 10 } });
  const first = await requestCode(target, "13844440001");
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().code, CANDIDATE_CODE, "真实外呼成功时返回短信服务下发的验证码");

  const second = await requestCode(target, "13844440001");
  assert.equal(second.statusCode, 429, "冷却窗口内必须限流: " + second.body);
  assert.equal(second.json().error.code, "SMS_COOLDOWN");
  assert.ok(second.headers["retry-after"], "应带 Retry-After 头");
  assert.ok(Number(second.headers["retry-after"]) > 0);

  // 不同号码不受影响
  const other = await requestCode(target, "13844440002");
  assert.equal(other.statusCode, 200, "冷却按号码计，不应误伤其他用户: " + other.body);
  await target.close();
});

test("号码日配额：超过 perNumberDaily 后返回 429 SMS_DAILY_LIMIT", async () => {
  const target = await makeApp({ throttle: { cooldownMs: 0, perNumberDaily: 3, globalDaily: 100 } });
  for (let i = 0; i < 3; i++) {
    const res = await requestCode(target, "13844440003");
    assert.equal(res.statusCode, 200, `第 ${i + 1} 次应在配额内: ` + res.body);
  }
  const over = await requestCode(target, "13844440003");
  assert.equal(over.statusCode, 429, over.body);
  assert.equal(over.json().error.code, "SMS_DAILY_LIMIT");
  await target.close();
});

test("全局日预算：多号码合计超过 globalDaily 后返回 429 SMS_GLOBAL_DAILY_LIMIT", async () => {
  const target = await makeApp({ throttle: { cooldownMs: 0, perNumberDaily: 10, globalDaily: 3 } });
  for (let i = 0; i < 3; i++) {
    const res = await requestCode(target, `1384444010${i}`);
    assert.equal(res.statusCode, 200, res.body);
  }
  const over = await requestCode(target, "13844440199");
  assert.equal(over.statusCode, 429, over.body);
  assert.equal(over.json().error.code, "SMS_GLOBAL_DAILY_LIMIT");
  await target.close();
});

test("发送失败时归还配额：不会出现「发失败还扣额度」", async () => {
  // perNumberDaily=1：若失败不回滚，第二次必然 429
  const target = await makeApp({ adapter: liveAdapter({ fail: true }), throttle: { cooldownMs: 0, perNumberDaily: 1, globalDaily: 1 } });
  const first = await requestCode(target, "13844440005");
  assert.equal(first.statusCode, 200, first.body); // 开发模式下回退为本地生成验证码
  const second = await requestCode(target, "13844440005");
  assert.equal(second.statusCode, 200, "失败已归还配额，第二次仍应放行: " + second.body);
  await target.close();
});

test("发码与登录分桶：request-code 被限流不影响 login-code 的独立额度", async () => {
  const target = await makeApp({ adapter: liveAdapter(), throttle: { cooldownMs: 60_000, perNumberDaily: 10 } });
  assert.equal((await requestCode(target, "13844440006")).statusCode, 200);
  // 立刻再次申请发码 → 命中冷却
  const cooled = await requestCode(target, "13844440006");
  assert.equal(cooled.statusCode, 429, cooled.body);
  assert.equal(cooled.json().error.code, "SMS_COOLDOWN");

  // login-code 使用独立桶：不应返回 429，而是走到"验证码错误"的业务分支
  const login = await target.inject({
    method: "POST",
    url: "/api/v1/auth/login-code",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ phone: "13844440006", code: "000000" }),
  });
  assert.notEqual(login.statusCode, 429, "login-code 不应消耗发码桶的额度: " + login.body);
  assert.equal(login.statusCode, 400, login.body);
  await target.close();
});

test("短信未启用（开发/测试）时不触发节流，保持既有联调语义", async () => {
  // 默认适配器：ALIYUN_SMS_ENABLED=false → isLive()=false → 不做号码级节流
  const target = await buildApp({ db, jwtSecret: "sms-throttle-secret-0123456789" });
  const first = await requestCode(target, "13844440007");
  const second = await requestCode(target, "13844440007");
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, "开发模式同一号码可连续申请（无外呼成本）: " + second.body);
  assert.ok(first.json().code, "开发模式回传验证码");
  await target.close();
});
