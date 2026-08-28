import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// 生产环境安全策略回归测试（P0）：
// - 生产模式忘记密码接口不得回传 reset token
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

test("生产模式：forgot-password 不回传 reset token，且无白名单时 CORS 不放行任意 Origin", () => {
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

// 注册一个用户
await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email: "prod@test.com", password: "password123", displayName: "P" }) });
const res = await app.inject({ method: "POST", url: "/api/v1/auth/forgot-password", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email: "prod@test.com" }) });

const body = JSON.parse(res.body);
console.log("RESULT_FORGOT_STATUS=" + res.statusCode);
console.log("RESULT_FORGOT_HAS_TOKEN=" + ("resetToken" in body));
console.log("RESULT_FORGOT_OK=" + (body.ok === true));

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
  assert.match(stdout, /RESULT_FORGOT_STATUS=200/);
  assert.match(stdout, /RESULT_FORGOT_HAS_TOKEN=false/, "生产模式不得回传 reset token");
  assert.match(stdout, /RESULT_FORGOT_OK=true/);
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
