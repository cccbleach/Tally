import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { users, nicknameHistory } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { smsRegister, authHeaders } from "./helpers.js";

// 回归：昵称身份语义。
// - 旧昵称改名后保留 30 天：到期前他人不可占用，到期后才可使用。
// - complete-profile / 修改昵称 / availability 共用同一判重逻辑（含未过期 nickname_history）。
// - 本人可占用自己名下的旧昵称（排除自身）。

process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";

let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;
let seq = 1;

function api(headers: Record<string, string>, method: string, url: string, body?: unknown) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  return app.inject({ method, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
}

async function makeUser() {
  const phone = `138${70000000 + seq++}`; // 11 位大陆手机号
  const r = await smsRegister(app, phone, `占位昵称${seq - 1}`);
  return { headers: authHeaders(r), id: r.user.id };
}

async function completeNickname(nickname: string): Promise<number> {
  // 未完成用户：验证码 → nickname_required → complete-profile
  const phone = `138${80000000 + seq++}`; // 11 位大陆手机号
  const codeRes = await api({}, "POST", "/api/v1/auth/request-code", { phone });
  const code = codeRes.json().code as string;
  const login = await api({}, "POST", "/api/v1/auth/login-code", { phone, code });
  const token = login.json().onboardingToken as string;
  const res = await api({}, "POST", "/api/v1/auth/complete-profile", { onboardingToken: token, nickname });
  return res.statusCode;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-nick-semantics-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "test-secret" });
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("旧昵称 30 天内不可被他人占用；到期后才可用（三处判重一致）", async () => {
  const a = await makeUser();
  // 记录旧昵称
  const me0 = await api(a.headers, "GET", "/api/v1/auth/me");
  const oldNick = me0.json().user.nickname as string;

  // 绕过 30 天冷却：把昵称变更时间拨回 31 天前，再改名
  db.update(users)
    .set({ nicknameChangedAt: new Date(Date.now() - 31 * 86400 * 1000).toISOString() })
    .where(eq(users.id, a.id))
    .run();
  const rename = await api(a.headers, "PATCH", "/api/v1/users/me/nickname", { nickname: "新名甲" });
  assert.equal(rename.statusCode, 200, rename.body);
  assert.equal(rename.json().user.nickname, "新名甲");

  // 旧昵称应已入历史（保留 30 天）
  const hist = db.select().from(nicknameHistory).all();
  assert.ok(hist.some((h) => h.userId === a.id && h.nickname === oldNick), "旧昵称应写入历史");

  // 到期前：availability / complete-profile / patch 三处都认为不可用
  const key = encodeURIComponent(oldNick);
  const availBefore = await api({}, "GET", "/api/v1/users/nickname-availability?nickname=" + key);
  assert.equal(availBefore.statusCode, 200);
  assert.equal(availBefore.json().available, false, "30 天内他人应不可占用旧昵称");

  const other = await makeUser();
  // 绕过 30 天冷却：证明命中的是「保留期内不可占用」，而不是改名冷却
  db.update(users)
    .set({ nicknameChangedAt: new Date(Date.now() - 31 * 86400 * 1000).toISOString() })
    .where(eq(users.id, other.id))
    .run();
  const patchBefore = await api(other.headers, "PATCH", "/api/v1/users/me/nickname", { nickname: oldNick });
  assert.equal(patchBefore.statusCode, 409, patchBefore.body);
  assert.equal(patchBefore.json().error.code, "NICKNAME_TAKEN");

  const cpBefore = await completeNickname(oldNick);
  assert.equal(cpBefore, 409, "complete-profile 在保留期内应返回 409");

  // 到期：把该历史条目的 expires_at 拨到过去
  const row = db
    .select()
    .from(nicknameHistory)
    .where(eq(nicknameHistory.userId, a.id), eq(nicknameHistory.nickname, oldNick))
    .get()!;
  db.update(nicknameHistory).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(nicknameHistory.id, row.id)).run();

  const availAfter = await api({}, "GET", "/api/v1/users/nickname-availability?nickname=" + key);
  assert.equal(availAfter.json().available, true, "到期后他人应可占用旧昵称");
  const other2 = await makeUser();
  db.update(users)
    .set({ nicknameChangedAt: new Date(Date.now() - 31 * 86400 * 1000).toISOString() })
    .where(eq(users.id, other2.id))
    .run();
  const patchAfter = await api(other2.headers, "PATCH", "/api/v1/users/me/nickname", { nickname: oldNick });
  assert.equal(patchAfter.statusCode, 200, patchAfter.body);
  assert.equal(patchAfter.json().user.nickname, oldNick);
});

test("本人可重新占用自己的旧昵称（排除自身历史与账号行）", async () => {
  const a = await makeUser();
  const me = await api(a.headers, "GET", "/api/v1/auth/me");
  const cur = me.json().user.nickname as string;

  db.update(users)
    .set({ nicknameChangedAt: new Date(Date.now() - 31 * 86400 * 1000).toISOString() })
    .where(eq(users.id, a.id))
    .run();
  const rename = await api(a.headers, "PATCH", "/api/v1/users/me/nickname", { nickname: "告别旧我" });
  assert.equal(rename.statusCode, 200, rename.body);

  // 改名后冷却重新生效；拨回 31 天前，让本人改回旧昵称走到可改名路径
  db.update(users)
    .set({ nicknameChangedAt: new Date(Date.now() - 31 * 86400 * 1000).toISOString() })
    .where(eq(users.id, a.id))
    .run();
  // 本人改回自己的旧昵称应成功（不会被自己的历史挡住）
  const reclaim = await api(a.headers, "PATCH", "/api/v1/users/me/nickname", { nickname: cur });
  assert.equal(reclaim.statusCode, 200, reclaim.body);
  assert.equal(reclaim.json().user.nickname, cur);
});
