import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// 生产环境安全策略回归测试（P0）：
// - 生产模式找回密码必须由短信真实投递：短信发不出去就是 503，
//   绝不出现「返回 200 成功但用户拿不到验证码/令牌」，也绝不把验证码回传客户端
// - 邮件找回入口（旧 forgot-password）必须已下线（404）
// - 生产模式未配置 CORS 白名单时不得放行任意 Origin
// - 生产模式必须拒绝示例/占位/过短的 JWT_SECRET（无法启动）
// 这些依赖模块加载时的环境变量，因此放到独立子进程里验证，避免与其它测试共享已缓存的 config。

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmpScriptFiles: string[] = [];

function runTsx(script: string, env: Record<string, string>): { stdout: string; stderr: string } {
  // 脚本写到 backend 目录内，使其中相对 ./src 的 import 能正确解析
  const file = join(BACKEND_DIR, `.prod-sec-${Math.random().toString(36).slice(2)}.ts`);
  tmpScriptFiles.push(file);
  writeFileSync(file, script);
  try {
    const stdout = execFileSync("node", ["--import", "tsx", file], {
      encoding: "utf8",
      cwd: BACKEND_DIR,
      env: { ...process.env, ...env, PATH: process.env.PATH },
    });
    return { stdout, stderr: "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { stdout: (err.stdout as string) ?? "", stderr: (err.stderr as string) ?? "" };
  }
}

after(() => {
  for (const f of tmpScriptFiles) {
    try { rmSync(f, { force: true }); } catch {}
  }
});

test("生产模式：找回密码不出现假成功（短信不可用→503），且无白名单时 CORS 不放行任意 Origin", () => {
  const script = `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDb } from "./src/db/client.js";
import { runMigrations } from "./src/db/runner.js";
import { buildApp } from "./src/server.js";
import { config } from "./src/config.js";

const dir = mkdtempSync(join(tmpdir(), "tally-prod-"));
const created = createDb(join(dir, "t.db"));
runMigrations(created.sqlite, resolve("./migrations"));
const app = await buildApp({ db: created.db, jwtSecret: process.env.JWT_SECRET! });

// 直接插入一个已完成昵称的手机号账号（生产模式短信不可用，无法通过 API 完成注册）
const now = new Date().toISOString();
created.sqlite.prepare("INSERT INTO users (id, phone, nickname, nickname_key, phone_verified_at, nickname_changed_at, profile_completed_at, default_ledger_id, current_ledger_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
  "prod-user", "+8613800000001", "生产用户", "生产用户", now, now, now, "prod-ledger", "prod-ledger", now, now
);
created.sqlite.prepare("INSERT INTO ledgers (id, user_id, name, is_default, created_at, updated_at) VALUES ('prod-ledger', 'prod-user', '默认账本', 1, ?, ?)").run(now, now);

// 1) 生产模式 + 短信未配置：申请验证码必须是 503，不能是 200（否则用户永远收不到验证码）
const res = await app.inject({ method: "POST", url: "/api/v1/auth/request-code", headers: { "content-type": "application/json" }, payload: JSON.stringify({ phone: "13800000001" }) });
const body = JSON.parse(res.body);
console.log("RESULT_RESETCODE_STATUS=" + res.statusCode);
console.log("RESULT_RESETCODE_HAS_CODE=" + ("code" in body));
console.log("RESULT_RESETCODE_FAKE_OK=" + (res.statusCode === 200 && body.ok === true));

// 2) 旧密码找回/密码登录整体下线：统一 410
const badReset = await app.inject({ method: "POST", url: "/api/v1/auth/reset-password", headers: { "content-type": "application/json" }, payload: JSON.stringify({ account: "13800000001", code: "000000", newPassword: "attacker123" }) });
console.log("RESULT_BADRESET_STATUS=" + badReset.statusCode);
const stillOk = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email: "13800000001", password: "password123" }) });
console.log("RESULT_OLDPASSWORD_STILL_WORKS=" + stillOk.statusCode);

// 3) 旧邮件找回入口应已下线
const legacy = await app.inject({ method: "POST", url: "/api/v1/auth/forgot-password", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email: "prod@test.com" }) });
console.log("RESULT_LEGACY_FORGOT_STATUS=" + legacy.statusCode);

// CORS：无白名单 + 生产模式，带 Origin 的请求不应获得 allow-origin 头
const cors = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example.com" } });
console.log("RESULT_CORS_ALLOW=" + (!!cors.headers["access-control-allow-origin"]));
created.sqlite.close();
`;
  const { stdout } = runTsx(script, {
    NODE_ENV: "production",
    JWT_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
    ALIYUN_SMS_ENABLED: "false",
    ALIYUN_ACCESS_KEY_ID: "",
    ALIYUN_ACCESS_KEY_SECRET: "",
    CORS_ORIGINS: "",
  });
  assert.match(stdout, /RESULT_RESETCODE_STATUS=503/, "短信不可用时生产模式必须 503: " + stdout);
  assert.match(stdout, /RESULT_RESETCODE_HAS_CODE=false/, "生产模式不得回传验证码");
  assert.match(stdout, /RESULT_RESETCODE_FAKE_OK=false/, "不得出现“返回成功但用户无法取得凭证”");
  assert.match(stdout, /RESULT_BADRESET_STATUS=410/, "密码找回已下线应 410");
  assert.match(stdout, /RESULT_OLDPASSWORD_STILL_WORKS=410/, "旧密码登录已下线应 410");
  assert.match(stdout, /RESULT_LEGACY_FORGOT_STATUS=404/, "邮件找回入口必须已从契约移除");
  assert.match(stdout, /RESULT_CORS_ALLOW=false/, "生产无白名单时 CORS 不应放行任意 Origin");
});

test("生产模式：示例/占位 JWT_SECRET 无法启动", () => {
  const script = `import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDb } from "./src/db/client.js";
import { runMigrations } from "./src/db/runner.js";
import { buildApp } from "./src/server.js";
const dir = mkdtempSync(join(tmpdir(), "tally-prod2-"));
const created = createDb(join(dir, "t.db"));
runMigrations(created.sqlite, resolve("./migrations"));
import "./src/config.js";
console.log("SHOULD_NOT_REACH");
`;
  const { stderr } = runTsx(script, {
    NODE_ENV: "production",
    JWT_SECRET: "please-change-me-to-a-long-random-string",
    ALIYUN_SMS_ENABLED: "false",
  });
  // 占位密钥应导致启动失败（config 模块抛错）
  assert.match(stderr, /JWT_SECRET/, "占位 JWT_SECRET 应被拒绝: " + stderr);
  assert.ok(!/SHOULD_NOT_REACH/.test(stderr), "不应正常启动");
});

// ---------------------------------------------------------------------------
// AUTH_MODE / DISABLE_RATE_LIMIT 生产互锁（Phase 0）
//
// 历史缺陷（已实测复现，可导致任意账号接管）：
//   AUTH_MODE 原先是无校验的强制类型转换，且判定写作 `config.authMode === "production"`，于是
//     (a) NODE_ENV=production AUTH_MODE=development → 请求验证码直接拿到明文 code；
//     (b) AUTH_MODE 拼错（如 develpoment）→ 同样退化为开发模式、同样回传明文 code；
//     (c) 未设 NODE_ENV（裸 node dist/index.js / systemd）→ 默认开发模式，同样回传。
//   已实测：用回传的 code 调用 login-code，对**已注册老账号**返回 status=authenticated。
// 修复要求：合法值域 + 生产互锁都在启动期硬失败，绝不静默降级。
// ---------------------------------------------------------------------------
const PHASE0_JWT_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

// 生产基线 env；额外键可覆盖（不传 NODE_ENV 即为“未设置”，测试进程本身无 NODE_ENV）
function prodEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "production",
    JWT_SECRET: PHASE0_JWT_SECRET,
    ALIYUN_SMS_ENABLED: "false",
    ALIYUN_ACCESS_KEY_ID: "",
    ALIYUN_ACCESS_KEY_SECRET: "",
    ...extra,
  };
}

const REFUSE_SCRIPT = `
import "./src/config.js";
console.log("SHOULD_NOT_REACH");
`;

// 失败时把 stdout + stderr 一起带进断言消息：子进程若因环境/资源问题没跑起来，
// 只看 stdout 会得到空字符串而无法定位（曾出现过一次并行跑全量时的空输出）。
function both(r: { stdout: string; stderr: string }): string {
  return "stdout=<" + r.stdout.trim() + "> stderr=<" + r.stderr.trim() + ">";
}

// 起真实 App 并申请一次验证码，打印认证模式与是否回传 code
const REQUEST_CODE_PROBE = `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDb } from "./src/db/client.js";
import { runMigrations } from "./src/db/runner.js";
import { buildApp } from "./src/server.js";
import { config } from "./src/config.js";

const dir = mkdtempSync(join(tmpdir(), "tally-authmode-"));
const created = createDb(join(dir, "t.db"));
runMigrations(created.sqlite, resolve("./migrations"));
const app = await buildApp({ db: created.db, jwtSecret: config.jwtSecret });
const res = await app.inject({
  method: "POST",
  url: "/api/v1/auth/request-code",
  headers: { "content-type": "application/json" },
  payload: JSON.stringify({ phone: "13800000001" }),
});
const body = JSON.parse(res.body);
console.log("RESULT_AUTHMODE=" + config.authMode);
console.log("RESULT_IS_PRODUCTION=" + config.isProduction);
console.log("RESULT_STATUS=" + res.statusCode);
console.log("RESULT_HAS_CODE=" + ("code" in body));
created.sqlite.close();
`;

test("生产模式：AUTH_MODE=development 必须拒绝启动（不得静默降级为明文回传验证码）", () => {
  const { stderr } = runTsx(REFUSE_SCRIPT, prodEnv({ AUTH_MODE: "development" }));
  assert.match(stderr, /AUTH_MODE/, "生产 + development 必须被拒绝: " + both({ stdout: "", stderr }));
  assert.ok(!/SHOULD_NOT_REACH/.test(stderr), "该组合不得正常启动");
});

test("生产模式：AUTH_MODE 拼错（非法值）必须拒绝启动，而不是退化成开发模式", () => {
  for (const bad of ["develpoment", "prod", "bogus", "1", "development "]) {
    const { stderr } = runTsx(REFUSE_SCRIPT, prodEnv({ AUTH_MODE: bad }));
    assert.match(stderr, /AUTH_MODE/, `非法 AUTH_MODE=${JSON.stringify(bad)} 必须被拒绝: ` + both({ stdout: "", stderr }));
    assert.ok(!/SHOULD_NOT_REACH/.test(stderr), `非法 AUTH_MODE=${JSON.stringify(bad)} 不得启动`);
  }
});

test("生产模式：DISABLE_RATE_LIMIT=true 必须拒绝启动（否则登录/验证码完全失去限流）", () => {
  const { stderr } = runTsx(REFUSE_SCRIPT, prodEnv({ DISABLE_RATE_LIMIT: "true" }));
  assert.match(stderr, /DISABLE_RATE_LIMIT/, "生产关闭限流必须被拒绝: " + both({ stdout: "", stderr }));
  assert.ok(!/SHOULD_NOT_REACH/.test(stderr), "生产关闭限流不得启动");
});

test("生产模式：AUTH_MODE 大小写/空白归一为 production，且验证码不回传", () => {
  const probe = runTsx(REQUEST_CODE_PROBE, prodEnv({ AUTH_MODE: "  PRODUCTION  " }));
  const info = both(probe);
  assert.match(probe.stdout, /RESULT_AUTHMODE=production/, "大小写/空白应归一为 production: " + info);
  assert.match(probe.stdout, /RESULT_IS_PRODUCTION=true/, "NODE_ENV=production 必须被识别: " + info);
  assert.match(probe.stdout, /RESULT_HAS_CODE=false/, "生产模式绝不得回传验证码: " + info);
  assert.match(probe.stdout, /RESULT_STATUS=503/, "未配置短信时申请验证码应为 503（不允许假成功）: " + info);
});

test("开发模式（未设 NODE_ENV）：验证码回传是有意契约；配置真实短信凭据时必须有醒目告警", () => {
  // (a) 未设 NODE_ENV → 开发模式，回传验证码（本地联调与测试套件依赖此语义，必须保持）
  const dev = runTsx(REQUEST_CODE_PROBE, {
    JWT_SECRET: PHASE0_JWT_SECRET,
    ALIYUN_SMS_ENABLED: "false",
    ALIYUN_ACCESS_KEY_ID: "",
    ALIYUN_ACCESS_KEY_SECRET: "",
  });
  const devInfo = both(dev);
  assert.match(dev.stdout, /RESULT_IS_PRODUCTION=false/, "未设 NODE_ENV 应视为非生产: " + devInfo);
  assert.match(dev.stdout, /RESULT_AUTHMODE=development/, "非生产默认开发模式: " + devInfo);
  assert.match(dev.stdout, /RESULT_HAS_CODE=true/, "开发模式回传验证码是既有联调契约: " + devInfo);
  assert.match(dev.stdout, /RESULT_STATUS=200/, "开发模式申请验证码应成功: " + devInfo);

  // (b) 开发模式 + 真实短信凭据（可真实外呼计费）= 危险组合，启动必须告警。
  //     只加载 config 并捕获 console.warn，不发起任何短信请求（无外呼、无网络）。
  const warnScript = `
const warnings = [];
const origin = console.warn;
console.warn = (...args) => { warnings.push(args.map((a) => String(a)).join(" ")); };
await import("./src/config.js");
console.warn = origin;
const hit = warnings.filter((w) => w.includes("开发模式"));
console.log("WARN_FIRED=" + (hit.length > 0));
console.log("WARN_MENTIONS_RISK=" + hit.some((w) => w.includes("切勿") || w.includes("生产")));
`;
  const warned = runTsx(warnScript, {
    JWT_SECRET: PHASE0_JWT_SECRET,
    ALIYUN_SMS_ENABLED: "true",
    ALIYUN_ACCESS_KEY_ID: "fake-ak-for-warning-test",
    ALIYUN_ACCESS_KEY_SECRET: "fake-sk-for-warning-test",
    // 父进程由 node:test 设置 NODE_TEST_CONTEXT，runTsx 会继承；
    // 告警在测试运行时会静默（避免 25 个测试文件刷屏），这里显式清空以验证告警确实存在。
    NODE_TEST_CONTEXT: "",
  });
  assert.match(warned.stdout, /WARN_FIRED=true/, "开发模式 + 真实短信凭据必须告警: " + both(warned));
  assert.match(warned.stdout, /WARN_MENTIONS_RISK=true/, "告警必须说明风险");
});
