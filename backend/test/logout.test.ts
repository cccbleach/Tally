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
import { smsRegister, smsLogin } from "./helpers.js";

// 服务端登出与会话吊销回归（Phase 1）：
// 历史缺陷：后端没有 /auth/logout，auth_sessions.revoked_at 从不用于"用户主动登出"，
// refresh token 默认 30 天有效 —— 令牌一旦泄漏，用户与运维都无法吊销。
let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;

function json(method: string, url: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = "Bearer " + token;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
}

const refresh = (rt: string) => json("POST", "/api/v1/auth/refresh", { refreshToken: rt });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-logout-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "logout-secret-0123456789" });
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("logout 后该 refresh token 不能再换取新令牌（其余设备不受影响）", async () => {
  await smsRegister(app, "13833330001", "登出用户");
  const deviceA = await smsLogin(app, "13833330001");
  const deviceB = await smsLogin(app, "13833330001");

  // A 登出（携带自己的 refreshToken）
  const res = await json("POST", "/api/v1/auth/logout", { refreshToken: deviceA.refreshToken }, deviceA.token);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().revoked, true, "应真正吊销一个会话");

  // A 的 refresh token 失效
  const afterA = await refresh(deviceA.refreshToken);
  assert.equal(afterA.statusCode, 401, "登出后 refresh 必须 401: " + afterA.body);

  // B 仍然可用（登出只影响当前设备）
  const afterB = await refresh(deviceB.refreshToken);
  assert.equal(afterB.statusCode, 200, "其他设备的会话不应被牵连: " + afterB.body);
});

test("logout 幂等：重复登出、缺 refreshToken、或他人的 token 都返回 ok 且不报错", async () => {
  const me = await smsLogin(app, "13833330001");
  const first = await json("POST", "/api/v1/auth/logout", { refreshToken: me.refreshToken }, me.token);
  assert.equal(first.json().revoked, true);
  const second = await json("POST", "/api/v1/auth/logout", { refreshToken: me.refreshToken }, me.token);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().revoked, false, "重复登出不应再次吊销");

  const noToken = await json("POST", "/api/v1/auth/logout", {}, me.token);
  assert.equal(noToken.statusCode, 200, noToken.body);
  assert.equal(noToken.json().revoked, false);

  // 别人的 refreshToken：不得跨用户吊销（攻击者用自己 access token 提交受害者的 refreshToken）
  const attacker = await smsLogin(app, "13833330001");
  const victimReg = await smsRegister(app, "13833330009", "受害者用户");
  const victimRefresh = victimReg.refreshToken as string;
  assert.ok(victimRefresh, "受害者应拿到 refreshToken");
  const cross = await json("POST", "/api/v1/auth/logout", { refreshToken: victimRefresh }, attacker.token);
  assert.equal(cross.statusCode, 200, cross.body);
  assert.equal(cross.json().revoked, false, "不能吊销他人的会话");
  assert.equal((await refresh(victimRefresh)).statusCode, 200, "他人会话必须仍然有效");
});

test("logout 需要认证：无 token 返回 401", async () => {
  const res = await json("POST", "/api/v1/auth/logout", {});
  assert.equal(res.statusCode, 401, res.body);
});

test("logout-all 吊销该用户全部会话（令牌泄漏时的兜底手段）", async () => {
  await smsRegister(app, "13833330003", "全端登出用户");
  const d1 = await smsLogin(app, "13833330003");
  const d2 = await smsLogin(app, "13833330003");
  const d3 = await smsLogin(app, "13833330003");

  const res = await json("POST", "/api/v1/auth/logout-all", {}, d1.token);
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(res.json().revoked >= 3, "应吊销至少 3 个会话: " + res.body);

  for (const d of [d1, d2, d3]) {
    assert.equal((await refresh(d.refreshToken)).statusCode, 401, "全部设备的 refresh 都必须失效");
  }
});

test("refresh 轮换是原子的：同一 token 只能用一次", async () => {
  await smsRegister(app, "13833330004", "轮换用户");
  const session = await smsLogin(app, "13833330004");

  const results = await Promise.all([
    refresh(session.refreshToken),
    refresh(session.refreshToken),
    refresh(session.refreshToken),
  ]);
  const okCount = results.filter((r) => r.statusCode === 200).length;
  assert.equal(okCount, 1, "同一 refresh token 只能成功轮换一次，实际成功 " + okCount + " 次");

  // 顺序重放同样必须失败
  assert.equal((await refresh(session.refreshToken)).statusCode, 401);
});
