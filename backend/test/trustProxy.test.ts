import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// TRUST_PROXY 语义回归测试：必须根据可信代理层数从 XFF 中选择真实客户端 IP，
// 不能固定采用最左侧（最左侧可由客户端伪造）。
// 由于 config 在模块加载时读取环境变量，这里用独立子进程在 TRUST_PROXY=1 下验证。

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmpScriptFiles: string[] = [];

function runTsx(script: string, env: Record<string, string>): { stdout: string; stderr: string } {
  const file = join(BACKEND_DIR, `.trust-proxy-${Math.random().toString(36).slice(2)}.ts`);
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

test("TRUST_PROXY=1 时使用 XFF 从右往左第 1 个地址（客户端伪造多段左侧不生效）", () => {
  const script = `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDb } from "./src/db/client.js";
import { runMigrations } from "./src/db/runner.js";
import { buildApp } from "./src/server.js";

const dir = mkdtempSync(join(tmpdir(), "tally-trust-"));
const created = createDb(join(dir, "t.db"));
runMigrations(created.sqlite, resolve("./migrations"));
const app = await buildApp({ db: created.db, jwtSecret: "test-secret", rateLimit: { max: 3, windowMs: 60_000 } });

// TRUST_PROXY=1 时，客户端伪造的左侧 IP 不同也无所谓：真实 IP 取最右侧（可信代理写入的客户端地址）。
// 这里每次伪造不同的左侧 IP，但右侧固定 172.16.0.5 → 全部命中同一 IP 限流桶 → 第 4 次应 429。
let lastStatus = 0;
for (let i = 0; i < 4; i++) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "x-forwarded-for": "203.0.113." + (i + 10) + ", 172.16.0.5", "content-type": "application/json" },
    payload: JSON.stringify({ email: "user" + i + "@test.com", password: "wrong" }),
  });
  lastStatus = r.statusCode;
}
console.log("RESULT_FOURTH_STATUS=" + lastStatus);
created.sqlite.close();
`;
  const { stdout } = runTsx(script, {
    TRUST_PROXY: "1",
    ALIYUN_SMS_ENABLED: "false",
    ALIYUN_ACCESS_KEY_ID: "",
    ALIYUN_ACCESS_KEY_SECRET: "",
  });
  assert.match(stdout, /RESULT_FOURTH_STATUS=429/, "TRUST_PROXY=1 时应按右侧真实 IP 计同一限流桶，第 4 次触发 429。输出: " + stdout);
});
