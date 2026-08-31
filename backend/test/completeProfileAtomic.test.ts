import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

function hashOf(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { users, authSessions, onboardingTickets, ledgers, categories, nicknameHistory } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

// 回归：complete-profile 全流程必须原子化。
// ticket 条件认领、昵称写入、profileCompletedAt、默认账本、默认分类、auth_session
// 必须同一数据库事务提交；任一步失败整体回滚（ticket 未使用、profile 未完成、
// 无 session、无孤儿账本/分类），且原 ticket 可安全重试。

process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";

let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;

function api(method: string, url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { "content-type": "application/json" },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function getOnboardingTicket(phone: string): Promise<string> {
  const codeRes = await api("POST", "/api/v1/auth/request-code", { phone });
  const code = codeRes.json().code as string;
  const login = await api("POST", "/api/v1/auth/login-code", { phone, code });
  assert.equal(login.json().status, "nickname_required");
  return login.json().onboardingToken as string;
}

function counts(userId: string) {
  return {
    sessions: db.select().from(authSessions).where(eq(authSessions.userId, userId)).all().length,
    ledgers: db.select().from(ledgers).where(eq(ledgers.userId, userId)).all().length,
    categories: db.select().from(categories).where(eq(categories.userId, userId)).all().length,
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-cp-atomic-"));
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

test("complete-profile 全流程原子提交：成功路径一次建齐", async () => {
  const ticket = await getOnboardingTicket("13870000001");
  const res = await api("POST", "/api/v1/auth/complete-profile", { onboardingToken: ticket, nickname: "原子甲" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, "authenticated");
  assert.ok(res.json().token);

  const uid = res.json().user.id as string;
  const u = db.select().from(users).where(eq(users.id, uid)).get()!;
  assert.equal(u.profileCompletedAt !== null, true, "profileCompletedAt 应已写入");
  assert.ok(u.defaultLedgerId, "应有默认账本");
  assert.equal(counts(uid).sessions, 1, "应有 1 个会话");
  assert.equal(counts(uid).ledgers, 1, "应有 1 个默认账本");
  assert.ok(counts(uid).categories >= 12, "应有默认分类");
});

test("默认账本 INSERT 失败 → 全部回滚，ticket 未使用，可安全重试", async () => {
  const ticket = await getOnboardingTicket("13870000002");
  sqlite.exec("CREATE TRIGGER fail_ledger BEFORE INSERT ON ledgers BEGIN SELECT RAISE(ABORT, 'forced ledger failure'); END;");
  try {
    const res = await api("POST", "/api/v1/auth/complete-profile", { onboardingToken: ticket, nickname: "原子乙" });
    assert.equal(res.statusCode, 500, res.body);
  } finally {
    sqlite.exec("DROP TRIGGER fail_ledger");
  }

  // 全部回滚：ticket 未使用、profile 未完成、无 session、无孤儿账本/分类
  const ticketRow = db.select().from(onboardingTickets).all();
  const pendingTicket = ticketRow.find((t) => t.usedAt === null);
  assert.ok(pendingTicket, "失败后应存在未使用的 ticket");

  // 找到该 ticket 的用户
  const holder = db.select().from(users).where(eq(users.id, pendingTicket!.userId)).get()!;
  assert.equal(holder.profileCompletedAt, null, "profile 应未完成");
  assert.equal(counts(holder.id).sessions, 0, "不应有 session");
  assert.equal(counts(holder.id).ledgers, 0, "不应有孤儿账本");
  assert.equal(counts(holder.id).categories, 0, "不应有孤儿分类");

  // 同一 ticket 重试应成功
  const retry = await api("POST", "/api/v1/auth/complete-profile", { onboardingToken: ticket, nickname: "原子乙" });
  assert.equal(retry.statusCode, 200, retry.body);
  const uid = retry.json().user.id as string;
  assert.ok(db.select().from(users).where(eq(users.id, uid)).get()!.defaultLedgerId);
  assert.equal(counts(uid).sessions, 1);
});

test("默认分类 INSERT 失败 → 全部回滚，ticket 未使用，可安全重试", async () => {
  const ticket = await getOnboardingTicket("13870000003");
  sqlite.exec("CREATE TRIGGER fail_categories BEFORE INSERT ON categories BEGIN SELECT RAISE(ABORT, 'forced categories failure'); END;");
  try {
    const res = await api("POST", "/api/v1/auth/complete-profile", { onboardingToken: ticket, nickname: "原子丙" });
    assert.equal(res.statusCode, 500, res.body);
  } finally {
    sqlite.exec("DROP TRIGGER fail_categories");
  }

  const ticketRow = db.select().from(onboardingTickets).all();
  const pendingTicket = ticketRow.find((t) => t.usedAt === null);
  assert.ok(pendingTicket, "失败后应存在未使用的 ticket");
  const holder = db.select().from(users).where(eq(users.id, pendingTicket!.userId)).get()!;
  assert.equal(holder.profileCompletedAt, null, "profile 应未完成");
  assert.equal(counts(holder.id).sessions, 0, "不应有 session");
  assert.equal(counts(holder.id).ledgers, 0, "不应有孤儿账本");
  assert.equal(counts(holder.id).categories, 0, "不应有孤儿分类");

  const retry = await api("POST", "/api/v1/auth/complete-profile", { onboardingToken: ticket, nickname: "原子丙" });
  assert.equal(retry.statusCode, 200, retry.body);
});

test("两张 ticket：第一张成功后第二张失败，昵称/冷却期/session 不受影响", async () => {
  const phone = "13870000004";
  // 未完成前重复登录会产生两张未使用 ticket
  const first = (await api("POST", "/api/v1/auth/login-code", { phone, code: (await api("POST", "/api/v1/auth/request-code", { phone })).json().code as string })).json();
  assert.equal(first.status, "nickname_required");
  const ticketA = first.onboardingToken as string;

  const second = (await api("POST", "/api/v1/auth/login-code", { phone, code: (await api("POST", "/api/v1/auth/request-code", { phone })).json().code as string })).json();
  assert.equal(second.status, "nickname_required");
  const ticketB = second.onboardingToken as string;
  assert.notEqual(ticketA, ticketB, "两次登录应得到不同的 onboard ticket");

  const ticketARow = db.select().from(onboardingTickets).where(eq(onboardingTickets.tokenHash, hashOf(ticketA))).get()!;
  const userId = ticketARow.userId;

  // 第一张成功
  const ok = await api("POST", "/api/v1/auth/complete-profile", { onboardingToken: ticketA, nickname: "两票甲" });
  assert.equal(ok.statusCode, 200, ok.body);
  const u = db.select().from(users).where(eq(users.id, userId)).get()!;
  assert.notEqual(u.profileCompletedAt, null, "第一张成功后资料应已完成");
  assert.equal(u.nickname, "两票甲");
  assert.ok(u.nicknameChangedAt, "成功后应设置改名冷却起点");

  // 成功后：两张 ticket 都应已作废（另一张未使用的在同一事务被作废）
  const allTickets = db.select().from(onboardingTickets).where(eq(onboardingTickets.userId, userId)).all();
  assert.equal(allTickets.length, 2, "应存在两张 ticket");
  for (const t of allTickets) {
    assert.notEqual(t.usedAt, null, "成功提交后所有 ticket 都应标记为已使用");
  }

  // 第二张（旧 ticket）必须返回明确 409，不能修改昵称、不能新建 session
  const fail = await api("POST", "/api/v1/auth/complete-profile", { onboardingToken: ticketB, nickname: "两票乙" });
  assert.equal(fail.statusCode, 409, fail.body);
  assert.equal(fail.json().error.code, "PROFILE_ALREADY_COMPLETED", fail.body);

  const after = db.select().from(users).where(eq(users.id, userId)).get()!;
  assert.equal(after.nickname, "两票甲", "409 时不得修改昵称");
  assert.equal(after.nicknameKey, u.nicknameKey, "nicknameKey 不应变化");
  assert.equal(after.nicknameChangedAt, u.nicknameChangedAt, "409 时不得重置改名冷却期");
  assert.equal(counts(userId).sessions, 1, "409 时不得新建 session");
  // 昵称历史：失败的第二张 ticket 不应产生任何历史条目
  const hist = db.select().from(nicknameHistory).where(eq(nicknameHistory.userId, userId)).all();
  assert.equal(hist.length, 0, "失败的 ticket 不应写入昵称历史");
  // 冷却期仍生效（nicknameChangeAvailableAt 已设置）
  assert.ok(ok.json().user.nicknameChangeAvailableAt, "完成后应有 30 天冷却期");
});
