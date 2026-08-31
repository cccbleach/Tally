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
import { smsRegister, smsLogin, authHeaders } from "./helpers.js";

process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";

let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;

function api(headers: Record<string, string>, method: string, url: string, body?: unknown) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  return app.inject({ method, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
}

async function getOnboardingToken(phone: string): Promise<string> {
  const codeRes = await app.inject({ method: "POST", url: "/api/v1/auth/request-code", headers: { "content-type": "application/json" }, payload: JSON.stringify({ phone }) });
  const code = codeRes.json().code as string;
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login-code", headers: { "content-type": "application/json" }, payload: JSON.stringify({ phone, code }) });
  assert.equal(login.json().status, "nickname_required");
  return login.json().onboardingToken as string;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-phone-nickname-"));
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

test("手机号 138… 与 +86138… 归一化为同一账号（E.164 冲突）", async () => {
  const a = await smsRegister(app, "13860000001", "归一甲");
  assert.equal(a.user.phone, "+8613860000001");
  const b = await smsRegister(app, "13860000002", "归一乙");
  const hB = authHeaders(b);

  const plus = await smsLogin(app, "+8613860000001");
  assert.equal(plus.status, "authenticated");
  assert.equal(plus.user.id, a.user.id);
  const spaced = await smsLogin(app, "+86 1386 0000 001");
  assert.equal(spaced.user.id, a.user.id);

  const bad = await api(hB, "POST", "/api/v1/auth/request-code", { phone: "12345" });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().error.code, "INVALID_PHONE");
});

test("昵称 NFKC+大小写不敏感判重：Abc 与 abc 冲突 / 保留系统词", async () => {
  const a = await smsRegister(app, "13860000003", "Abc");
  const hA = authHeaders(a);

  const ticket = await getOnboardingToken("13860000004");
  const clash = await api(hA, "POST", "/api/v1/auth/complete-profile", { onboardingToken: ticket, nickname: "abc" });
  assert.equal(clash.statusCode, 409, clash.body);
  assert.equal(clash.json().error.code, "NICKNAME_TAKEN");

  const avail = await api(hA, "GET", "/api/v1/users/nickname-availability?nickname=aBc");
  assert.equal(avail.json().available, false, "nickname-availability 应反映大小写不敏感冲突");
  const sys = await api(hA, "GET", "/api/v1/users/nickname-availability?nickname=admin");
  assert.equal(sys.json().available, false, "admin 应被保留");
  const pure = await api(hA, "GET", "/api/v1/users/nickname-availability?nickname=123");
  assert.equal(pure.json().available, false, "纯数字昵称应不可用");
});

test("并发注册同名昵称：只有一个能成功", async () => {
  // smsRegister 在 complete-profile 失败（NICKNAME_TAKEN）时抛错；
  // 并发同名注册允许一个失败，因此捕获并计数。
  async function attempt(phone: string) {
    try {
      const r = await smsRegister(app, phone, "撞名");
      return r;
    } catch {
      return null;
    }
  }
  const results = await Promise.all([attempt("13860000005"), attempt("13860000006")]);
  const ok = results.filter((r): r is NonNullable<typeof r> => r !== null);
  assert.equal(ok.length, 1, "两个并发同名注册只能成功一个");
  const rowCount = db.select().from(users).all().filter((u) => u.nickname === "撞名").length;
  assert.equal(rowCount, 1, "数据库应只有一条该昵称");

  // 失败者仍是 nickname_required，改其它昵称可完成
  const loserPhone = results[0] && results[0] !== null ? "13860000006" : "13860000005";
  const ticket = await getOnboardingToken(loserPhone);
  const fix = await api({}, "POST", "/api/v1/auth/complete-profile", { onboardingToken: ticket, nickname: "撞名二号" });
  assert.equal(fix.statusCode, 200, fix.body);
});

test("30 天改名冷却 + 旧昵称保留 + 旧昵称可被他人占用", async () => {
  const me = await smsRegister(app, "13860000007", "改名甲");
  const h = authHeaders(me);

  const hot = await api(h, "PATCH", "/api/v1/users/me/nickname", { nickname: "改名乙" });
  assert.equal(hot.statusCode, 409, hot.body);
  assert.equal(hot.json().error.code, "NICKNAME_CHANGE_COOLDOWN");

  const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  db.update(users).set({ nicknameChangedAt: past, updatedAt: new Date().toISOString() }).where(eq(users.id, me.user.id)).run();
  const ok = await api(h, "PATCH", "/api/v1/users/me/nickname", { nickname: "改名乙" });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().user.nickname, "改名乙");

  const hist = db.select().from(nicknameHistory).all();
  assert.ok(hist.some((r) => r.nickname === "改名甲" && r.userId === me.user.id), "旧昵称应保留到历史表");

  // 旧昵称进入 30 天保留期：到期前其他用户不可占用
  const retained = await api({}, "POST", "/api/v1/auth/request-code", { phone: "13860000009" });
  const rc = retained.json().code as string;
  const rlogin = await api({}, "POST", "/api/v1/auth/login-code", { phone: "13860000009", code: rc });
  const rtoken = rlogin.json().onboardingToken as string;
  const rcp = await api({}, "POST", "/api/v1/auth/complete-profile", { onboardingToken: rtoken, nickname: "改名甲" });
  assert.equal(rcp.statusCode, 409, "保留期内 complete-profile 同名应 409: " + rcp.body);
  assert.equal(rcp.json().error.code, "NICKNAME_TAKEN");

  // 到期后（把历史 expires_at 拨到过去）其他用户即可占用
  const histRow = hist.find((r) => r.nickname === "改名甲" && r.userId === me.user.id)!;
  db.update(nicknameHistory).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(nicknameHistory.id, histRow.id)).run();
  const other = await smsRegister(app, "13860000008", "改名甲");
  assert.equal(other.user.nickname, "改名甲");
});
