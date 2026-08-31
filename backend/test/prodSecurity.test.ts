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
created.sqlite.prepare("INSERT INTO ledgers (id, user_id, name, currency, is_default, created_at, updated_at) VALUES ('prod-ledger', 'prod-user', '默认账本', 'CNY', 1, ?, ?)").run(now, now);

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
