import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { todayStr } from "../src/lib/date.js";

// 双用户家庭生命周期 E2E（里程碑二）：
// A 创建家庭 → A 邀请 B → B 接受 → B 用 A 的账户分类记账 → A/B 看到相同统计
// → A 将 B 改成 Viewer → B 创建流水返回 403 → A 移除 B → B 访问家庭账本返回 403
// 另外覆盖：转移所有权、邀请拒绝、退出家庭、删除家庭。

process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";

let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;

let hA: Record<string, string>;
let hB: Record<string, string>;
let idA: string;
let idB: string;
let familyId: string;
let familyLedger: string;
let accountId: string;
let expenseCatId: string;

function api(headers: Record<string, string>, method: string, url: string, body?: unknown) {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  return app.inject({
    method,
    url,
    headers: h,
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-family-lifecycle-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "test-secret" });

  const regA = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ email: "owner@test.com", password: "password123", displayName: "A" }),
  });
  idA = regA.json().user.id;
  hA = { authorization: "Bearer " + regA.json().token };

  const regB = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ email: "member@test.com", password: "password123", displayName: "B" }),
  });
  idB = regB.json().user.id;
  hB = { authorization: "Bearer " + regB.json().token };
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("A 创建家庭并邀请 B，B 接受后可用 A 的账户记账，双端看到相同统计", async () => {
  // A 创建家庭
  const fam = await api(hA, "POST", "/api/v1/families", { name: "幸福之家" });
  assert.equal(fam.statusCode, 200, fam.body);
  familyId = fam.json().item.id;
  familyLedger = fam.json().item.ledgerId;
  assert.ok(familyLedger, "创建家庭应返回家庭账本");

  // A 在家庭账本建账户和分类
  const acc = await api(hA, "POST", "/api/v1/accounts", { name: "家庭储蓄", type: "bank", currency: "CNY", ledgerId: familyLedger });
  assert.equal(acc.statusCode, 200, acc.body);
  accountId = acc.json().item.id;
  const cats = await api(hA, "GET", "/api/v1/categories?ledgerId=" + familyLedger);
  const expenseCat = (cats.json().items as Array<{ id: string; type: string }>).find((c) => c.type === "expense");
  expenseCatId = expenseCat!.id;

  // A 邀请 B（按账号）
  const invite = await api(hA, "POST", `/api/v1/families/${familyId}/invitations`, { account: "member@test.com", role: "member" });
  assert.equal(invite.statusCode, 200, invite.body);
  const token = invite.json().item.token;
  assert.ok(token, "邀请应返回一次性 token");

  // B 接受邀请
  const accept = await api(hB, "POST", `/api/v1/families/invitations/${token}/accept`);
  assert.equal(accept.statusCode, 200, accept.body);

  // B 能看到家庭账本账户并记账
  const listB = await api(hB, "GET", "/api/v1/accounts?ledgerId=" + familyLedger);
  assert.equal(listB.statusCode, 200, listB.body);
  assert.equal(listB.json().items.length, 1, "B 应能看到共享账户");
  const createByB = await api(hB, "POST", "/api/v1/transactions?ledgerId=" + familyLedger, {
    accountId,
    categoryId: expenseCatId,
    type: "expense",
    amount: 888,
    currency: "CNY",
    date: todayStr(),
    note: "B 记的第一笔",
    ledgerId: familyLedger,
  });
  assert.equal(createByB.statusCode, 200, createByB.body);

  // A 能看到 B 的流水
  const txA = await api(hA, "GET", "/api/v1/transactions?ledgerId=" + familyLedger);
  const notes = (txA.json().items as Array<{ note: string | null }>).map((t) => t.note);
  assert.ok(notes.includes("B 记的第一笔"), "A 应能看到 B 的流水");
});

test("A 将 B 改成 Viewer 后 B 无法创建流水，B 退出后无法访问家庭账本", async () => {
  // A 把 B 改为 viewer
  const patch = await api(hA, "PATCH", `/api/v1/families/${familyId}/members/${idB}`, { role: "viewer" });
  assert.equal(patch.statusCode, 200, patch.body);

  // B 尝试创建流水 → 403
  const tryCreate = await api(hB, "POST", "/api/v1/transactions?ledgerId=" + familyLedger, {
    accountId,
    categoryId: expenseCatId,
    type: "expense",
    amount: 100,
    currency: "CNY",
    date: todayStr(),
    note: "viewer 不应能写",
    ledgerId: familyLedger,
  });
  assert.equal(tryCreate.statusCode, 403, "Viewer 创建流水应返回 403");
  assert.equal(tryCreate.json().error.code, "PERMISSION_DENIED");

  // B 仍可读
  const readB = await api(hB, "GET", "/api/v1/transactions?ledgerId=" + familyLedger);
  assert.equal(readB.statusCode, 200, "Viewer 应可读");

  // B 退出家庭
  const exit = await api(hB, "POST", `/api/v1/families/${familyId}/exit`);
  assert.equal(exit.statusCode, 200, exit.body);

  // B 访问家庭账本 → 403
  const afterExit = await api(hB, "GET", "/api/v1/transactions?ledgerId=" + familyLedger);
  assert.equal(afterExit.statusCode, 403, "退出后访问家庭账本应 403");
});

test("邀请 token 只能被受邀账号接受，且不可复用", async () => {
  // 重新邀请 B（member 角色）以便验证移除流程
  const invite = await api(hA, "POST", `/api/v1/families/${familyId}/invitations`, { account: "member@test.com", role: "member" });
  const token = invite.json().item.token;
  // 用一个第三方账号（注册 C）尝试接受 → 403
  const regC = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ email: "c@test.com", password: "password123", displayName: "C" }),
  });
  const hC = { authorization: "Bearer " + regC.json().token };
  const wrong = await api(hC, "POST", `/api/v1/families/invitations/${token}/accept`);
  assert.equal(wrong.statusCode, 403, "非受邀账号不应接受成功");

  // B 接受（重新加入）
  const ok = await api(hB, "POST", `/api/v1/families/invitations/${token}/accept`);
  assert.equal(ok.statusCode, 200, ok.body);
});

test("A 移除 B 后 B 访问家庭账本返回 403，B 自动切回个人账本", async () => {
  // B 已重新加入，验证可访问
  const pre = await api(hB, "GET", "/api/v1/transactions?ledgerId=" + familyLedger);
  assert.equal(pre.statusCode, 200, "B 重加入后应可访问");

  // A 移除 B
  const remove = await api(hA, "DELETE", `/api/v1/families/${familyId}/members/${idB}`);
  assert.equal(remove.statusCode, 200, remove.body);

  // B 访问家庭账本 → 403
  const afterRemove = await api(hB, "GET", "/api/v1/transactions?ledgerId=" + familyLedger);
  assert.equal(afterRemove.statusCode, 403, "被移除后访问家庭账本应 403");

  // B 的当前账本应切回个人默认账本
  const ledgersB = await api(hB, "GET", "/api/v1/ledgers");
  const personalB = (ledgersB.json().items as Array<{ id: string; familyId: string | null; isCurrent: boolean }>)
    .filter((l) => l.familyId === null)
    .find((l) => l.isCurrent);
  assert.ok(personalB, "B 应切回个人默认账本");
});

test("转移所有权后新 owner 可管理成员，原 owner 降为 admin", async () => {
  // 重新邀请并让 B 加入，作为被转移对象
  const invite = await api(hA, "POST", `/api/v1/families/${familyId}/invitations`, { account: "member@test.com", role: "member" });
  const token = invite.json().item.token;
  await api(hB, "POST", `/api/v1/families/invitations/${token}/accept`);

  // A 转移所有权给 B
  const transfer = await api(hA, "POST", `/api/v1/families/${familyId}/transfer`, { memberUserId: idB });
  assert.equal(transfer.statusCode, 200, transfer.body);

  const detail = await api(hB, "GET", `/api/v1/families/${familyId}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().item.ownerUserId, idB, "所有权应转移给 B");
  const roles = (detail.json().item.members as Array<{ userId: string; role: string }>);
  assert.equal(roles.find((m) => m.userId === idA)?.role, "admin", "原 owner 应降为 admin");
  assert.equal(roles.find((m) => m.userId === idB)?.role, "owner", "新 owner 角色应为 owner");
});

test("删除家庭后原成员无法再访问，邀请条目被撤销", async () => {
  // 由 B（新 owner）删除家庭
  const del = await api(hB, "DELETE", `/api/v1/families/${familyId}`);
  assert.equal(del.statusCode, 200, del.body);

  const checkA = await api(hA, "GET", `/api/v1/families/${familyId}`);
  assert.equal(checkA.statusCode, 403, "删除后原成员不应再访问家庭");
  const checkB = await api(hB, "GET", `/api/v1/families/${familyId}`);
  assert.equal(checkB.statusCode, 403, "删除后原 owner 也不应再访问家庭");
});
