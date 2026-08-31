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
import { eq } from "drizzle-orm";
import { ledgers, budgets, transactions } from "../src/db/schema.js";
import { smsRegister, authHeaders } from "./helpers.js";

// 权限与数据隔离 + 单家庭生命周期 + 预算唯一性 + 跨币种策略 回归测试（P0）
process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";

let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;

let hA: Record<string, string>;
let hB: Record<string, string>;
let idB: string;
let familyId: string;
let familyLedger: string;
let personalLedgerA: string;
let accountId: string;
let expenseCat: string;

function api(headers: Record<string, string>, method: string, url: string, body?: unknown) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  return app.inject({
    method,
    url,
    headers: h,
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-rbac-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "test-secret" });

  const a = await smsRegister(app, "13850000001", "权限甲");
  hA = authHeaders(a);
  const b = await smsRegister(app, "13850000002", "权限乙");
  hB = authHeaders(b);
  idB = b.user.id;
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("A 创建家庭、按昵称邀请 B，B 接受后 member 可写共享账本全部接口", async () => {
  const fam = await api(hA, "POST", "/api/v1/families", { name: "家庭" });
  assert.equal(fam.statusCode, 200, fam.body);
  familyId = fam.json().item.id;
  familyLedger = fam.json().item.ledgerId;
  assert.ok(familyLedger);

  const invite = await api(hA, "POST", `/api/v1/families/${familyId}/invitations`, { nickname: "权限乙" });
  assert.equal(invite.statusCode, 200, invite.body);
  const inviteId = invite.json().item.id as string;
  const accept = await api(hB, "POST", `/api/v1/families/invitations/${inviteId}/accept`);
  assert.equal(accept.statusCode, 200, accept.body);

  // 建立账户/分类
  const acc = await api(hA, "POST", "/api/v1/accounts", { name: "家庭户", type: "bank", currency: "CNY", ledgerId: familyLedger });
  assert.equal(acc.statusCode, 200, acc.body);
  accountId = acc.json().item.id;
  const cats = await api(hA, "GET", "/api/v1/categories?ledgerId=" + familyLedger);
  const expense = (cats.json().items as Array<{ id: string; type: string }>).find((c) => c.type === "expense");
  expenseCat = expense!.id;

  // member（B）可写：预算
  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;
  const budget = await api(hB, "POST", "/api/v1/budgets", { year, month, amount: 10000, ledgerId: familyLedger });
  assert.equal(budget.statusCode, 200, "member 创建预算应成功: " + budget.body);

  // member 可写：周期账单
  const recurring = await api(hB, "POST", "/api/v1/recurring", {
    accountId,
    categoryId: expenseCat,
    type: "expense",
    amount: 1000,
    frequency: "monthly",
    startDate: todayStr(),
    ledgerId: familyLedger,
  });
  assert.equal(recurring.statusCode, 200, "member 创建周期账单应成功: " + recurring.body);

  // member 可写：贷款
  const loanAcc = await api(hB, "POST", "/api/v1/accounts", { name: "家庭借款", type: "loan", currency: "CNY", ledgerId: familyLedger });
  const loan = await api(hB, "POST", "/api/v1/loans", {
    name: "房贷",
    type: "mortgage",
    principal: 1000000,
    annualRate: 4,
    termMonths: 360,
    startDate: todayStr(),
    liabilityAccountId: loanAcc.json().item.id,
    ledgerId: familyLedger,
  });
  assert.equal(loan.statusCode, 200, "member 创建贷款应成功: " + loan.body);

  // member 可写：信用卡账单
  const creditCard = await api(hB, "POST", "/api/v1/accounts", { name: "家庭卡", type: "credit", currency: "CNY", ledgerId: familyLedger });
  const bill = await api(hB, "POST", `/api/v1/credit-cards/${creditCard.json().item.id}/bills`, {
    period: "2026-08",
    statementBalance: 1000,
    ledgerId: familyLedger,
  });
  assert.equal(bill.statusCode, 200, "member 创建信用卡账单应成功: " + bill.body);

  // member 可写：导入任务
  const imp = await api(hB, "POST", "/api/v1/imports/jobs", {
    mode: "items",
    source: "wechat",
    items: [{ date: todayStr(), amount: 10, type: "expense", note: "x", externalId: "v1" }],
    ledgerId: familyLedger,
  });
  assert.equal(imp.statusCode, 200, "member 创建导入任务应成功: " + imp.body);

  // member 可写：旧版导入 + link
  const importResp = await api(hB, "POST", "/api/v1/transactions/import", {
    mode: "items",
    items: [{ date: todayStr(), amount: 11, type: "expense", note: "old-import", externalId: "old-import-1" }],
    ledgerId: familyLedger,
  });
  assert.equal(importResp.statusCode, 200, "member 旧版导入应成功: " + importResp.body);
});

test("member 不能修改/删除其他成员流水，只能改自己的；owner 可改任意", async () => {
  // A 在家庭账本记一笔
  const txA = await api(hA, "POST", "/api/v1/transactions", {
    accountId,
    categoryId: expenseCat,
    type: "expense",
    amount: 500,
    currency: "CNY",
    date: todayStr(),
    note: "A 记的",
    ledgerId: familyLedger,
  });
  assert.equal(txA.statusCode, 200, txA.body);
  const txAId = txA.json().item.id;

  // B（member）尝试改 A 的流水 → 403
  const patchByB = await api(hB, "PATCH", `/api/v1/transactions/${txAId}`, { amount: 600, ledgerId: familyLedger });
  assert.equal(patchByB.statusCode, 403, "member 修改他人流水应 403: " + patchByB.body);
  assert.equal(patchByB.json().error.code, "PERMISSION_DENIED");

  // B（member）尝试删 A 的流水 → 403
  const delByB = await api(hB, "DELETE", `/api/v1/transactions/${txAId}?ledgerId=${familyLedger}`);
  assert.equal(delByB.statusCode, 403, "member 删除他人流水应 403: " + delByB.body);

  // B 记一笔自己的
  const txB = await api(hB, "POST", "/api/v1/transactions", {
    accountId,
    categoryId: expenseCat,
    type: "expense",
    amount: 300,
    currency: "CNY",
    date: todayStr(),
    note: "B 自己的",
    ledgerId: familyLedger,
  });
  assert.equal(txB.statusCode, 200, txB.body);
  const txBId = txB.json().item.id;

  // B 改自己的 → 200
  const patchOwn = await api(hB, "PATCH", `/api/v1/transactions/${txBId}`, { amount: 333, ledgerId: familyLedger });
  assert.equal(patchOwn.statusCode, 200, "member 应能改自己的流水: " + patchOwn.body);

  // owner（A）改 B 的流水 → 200
  const txB2 = await api(hB, "POST", "/api/v1/transactions", {
    accountId,
    categoryId: expenseCat,
    type: "expense",
    amount: 100,
    currency: "CNY",
    date: todayStr(),
    note: "B 再记一笔",
    ledgerId: familyLedger,
  });
  const txB2Id = txB2.json().item.id;
  const patchByOwner = await api(hA, "PATCH", `/api/v1/transactions/${txB2Id}`, { amount: 120, ledgerId: familyLedger });
  assert.equal(patchByOwner.statusCode, 200, "owner 应能改任意成员流水: " + patchByOwner.body);
});

test("预算唯一性按 ledger 作用域：同一用户个人账本与家庭账本同月同分类可共存", async () => {
  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;

  const ledgersRes = await api(hA, "GET", "/api/v1/ledgers");
  const personal = (ledgersRes.json().items as Array<{ id: string; familyId: string | null }>).find((l) => l.familyId === null);
  assert.ok(personal, "A 应有个人账本");
  personalLedgerA = personal!.id;

  // 个人账本建分类预算
  const personalCats = await api(hA, "GET", "/api/v1/categories?ledgerId=" + personalLedgerA);
  const personalCat = (personalCats.json().items as Array<{ id: string; type: string }>).find((c) => c.type === "expense");
  assert.ok(personalCat);
  const b1 = await api(hA, "POST", "/api/v1/budgets", { year, month, categoryId: personalCat!.id, amount: 1000, ledgerId: personalLedgerA });
  assert.equal(b1.statusCode, 200, "个人账本预算: " + b1.body);

  // 家庭账本同月同分类预算 → 成功（不同 ledger）
  const b2 = await api(hA, "POST", "/api/v1/budgets", { year, month, categoryId: expenseCat, amount: 2000, ledgerId: familyLedger });
  assert.equal(b2.statusCode, 200, "家庭账本同分类预算应成功而不是 500: " + b2.body);

  const rows = db
    .select()
    .from(budgets)
    .where(eq(budgets.year, year), eq(budgets.month, month))
    .all();
  assert.ok(rows.length >= 2, "个人与家庭账本应各有独立预算行");
});

test("跨币种转账/还款被明确拒绝", async () => {
  const fxAcc = await api(hA, "POST", "/api/v1/accounts", { name: "美元户", type: "bank", currency: "USD", ledgerId: familyLedger });
  assert.equal(fxAcc.statusCode, 200, fxAcc.body);
  const fxId = fxAcc.json().item.id;

  const transfer = await api(hA, "POST", "/api/v1/transactions", {
    accountId,
    transferToAccountId: fxId,
    type: "transfer",
    amount: 100,
    currency: "CNY",
    date: todayStr(),
    ledgerId: familyLedger,
  });
  assert.equal(transfer.statusCode, 400, "跨币种转账应 400: " + transfer.body);
  assert.equal(transfer.json().error.code, "CURRENCY_MISMATCH");

  const wrongCur = await api(hA, "POST", "/api/v1/transactions", {
    accountId,
    categoryId: expenseCat,
    type: "expense",
    amount: 100,
    currency: "USD",
    date: todayStr(),
    ledgerId: familyLedger,
  });
  assert.equal(wrongCur.statusCode, 400, "账户与流水币种不一致应 400: " + wrongCur.body);
  assert.equal(wrongCur.json().error.code, "CURRENCY_MISMATCH");
});

test("删除家庭后：原 owner 无法访问旧家庭账本，当前账本回退个人账本，历史数据保留但不可见", async () => {
  const beforeDel = await api(hA, "GET", `/api/v1/transactions?ledgerId=${familyLedger}`);
  assert.equal(beforeDel.statusCode, 200, beforeDel.body);
  assert.ok(beforeDel.json().items.length > 0, "删除前应有流水");

  const del = await api(hA, "DELETE", `/api/v1/families/${familyId}`);
  assert.equal(del.statusCode, 200, del.body);

  const afterDel = await api(hA, "GET", `/api/v1/transactions?ledgerId=${familyLedger}`);
  assert.equal(afterDel.statusCode, 404, "删除后原 owner 不应再访问旧家庭账本: " + afterDel.body);

  const ledgersAfter = await api(hA, "GET", "/api/v1/ledgers");
  const listed = (ledgersAfter.json().items as Array<{ id: string }>).map((l) => l.id);
  assert.ok(!listed.includes(familyLedger), "ledgers 不应包含已删除的家庭账本");
  const current = (ledgersAfter.json().items as Array<{ id: string; isCurrent: boolean }>).find((l) => l.isCurrent);
  assert.ok(current, "应有一个当前账本");
  assert.equal(current!.id, personalLedgerA, "当前账本应回退到个人默认账本");

  const ledgerRow = db.select().from(ledgers).where(eq(ledgers.id, familyLedger)).get();
  assert.ok(ledgerRow, "家庭账本行应保留");
  assert.ok(ledgerRow!.deletedAt, "家庭账本应标记 deletedAt");
  const txRows = db.select().from(transactions).where(eq(transactions.ledgerId, familyLedger)).all();
  assert.ok(txRows.length > 0, "删除家庭后的历史流水应保留（软删除策略）");
});
