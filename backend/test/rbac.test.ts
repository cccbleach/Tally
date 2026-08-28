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

// 权限与数据隔离 + 家庭生命周期 + 预算唯一性 + 跨币种策略 回归测试（P0）
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

async function register(email: string, displayName: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ email, password: "password123", displayName }),
  });
  assert.equal(res.statusCode, 200, res.body);
  return { id: res.json().user.id as string, h: { authorization: "Bearer " + res.json().token } };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-rbac-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "test-secret" });

  const a = await register("rbac-owner@test.com", "A");
  const b = await register("rbac-member@test.com", "B");
  hA = a.h;
  hB = b.h;
  idA = a.id;
  idB = b.id;
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("全写接口权限矩阵：viewer 对预算/周期账单/贷款/信用卡账单/导入任务均 403", async () => {
  // A 创建家庭
  const fam = await api(hA, "POST", "/api/v1/families", { name: "家庭" });
  assert.equal(fam.statusCode, 200, fam.body);
  familyId = fam.json().item.id;
  familyLedger = fam.json().item.ledgerId;
  assert.ok(familyLedger);

  // A 加 B 为 member，并建立账户/分类
  await api(hA, "POST", `/api/v1/families/${familyId}/members`, { account: "rbac-member@test.com" });
  const acc = await api(hA, "POST", "/api/v1/accounts", { name: "家庭户", type: "bank", currency: "CNY", ledgerId: familyLedger });
  assert.equal(acc.statusCode, 200, acc.body);
  accountId = acc.json().item.id;
  const cats = await api(hA, "GET", "/api/v1/categories?ledgerId=" + familyLedger);
  const expense = (cats.json().items as Array<{ id: string; type: string }>).find((c) => c.type === "expense");
  assert.ok(expense, "应有支出分类");
  expenseCat = expense!.id;

  // 把 B 改成 viewer
  const toViewer = await api(hA, "PATCH", `/api/v1/families/${familyId}/members/${idB}`, { role: "viewer" });
  assert.equal(toViewer.statusCode, 200, toViewer.body);

  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;

  // viewer 创建预算 → 403
  const budget = await api(hB, "POST", "/api/v1/budgets", { year, month, amount: 10000, ledgerId: familyLedger });
  assert.equal(budget.statusCode, 403, "viewer 创建预算应 403: " + budget.body);

  // viewer 创建周期账单 → 403
  const recurring = await api(hB, "POST", "/api/v1/recurring", {
    accountId,
    categoryId: expenseCat,
    type: "expense",
    amount: 1000,
    frequency: "monthly",
    startDate: todayStr(),
    ledgerId: familyLedger,
  });
  assert.equal(recurring.statusCode, 403, "viewer 创建周期账单应 403: " + recurring.body);

  // viewer 创建贷款 → 403
  const loanAcc = await api(hA, "POST", "/api/v1/accounts", { name: "家庭借款", type: "loan", currency: "CNY", ledgerId: familyLedger });
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
  assert.equal(loan.statusCode, 403, "viewer 创建贷款应 403: " + loan.body);

  // viewer 创建信用卡账单 → 403
  const creditCard = await api(hA, "POST", "/api/v1/accounts", { name: "家庭卡", type: "credit", currency: "CNY", ledgerId: familyLedger });
  const bill = await api(hB, "POST", `/api/v1/credit-cards/${creditCard.json().item.id}/bills`, {
    period: "2026-08",
    statementBalance: 1000,
    ledgerId: familyLedger,
  });
  assert.equal(bill.statusCode, 403, "viewer 创建信用卡账单应 403: " + bill.body);

  // viewer 创建导入任务 → 403
  const imp = await api(hB, "POST", "/api/v1/imports/jobs", {
    mode: "items",
    source: "wechat",
    items: [{ date: todayStr(), amount: 10, type: "expense", note: "x", externalId: "v1" }],
    ledgerId: familyLedger,
  });
  assert.equal(imp.statusCode, 403, "viewer 创建导入任务应 403: " + imp.body);
});

test("viewer 对旧版 transactions/import 与 transactions/link 写操作返回 403", async () => {
  // 旧版批量导入也是写操作：viewer 必须 403
  const importResp = await api(hB, "POST", "/api/v1/transactions/import", {
    mode: "items",
    items: [{ date: todayStr(), amount: 11, type: "expense", note: "old-import", externalId: "old-import-1" }],
    ledgerId: familyLedger,
  });
  assert.equal(importResp.statusCode, 403, "viewer 旧版导入应 403: " + importResp.body);

  // link 是写操作：先由 owner 建两条流水，viewer 尝试 link → 403（无写权限）
  const t1 = await api(hA, "POST", "/api/v1/transactions", {
    accountId,
    categoryId: expenseCat,
    type: "expense",
    amount: 55,
    currency: "CNY",
    date: todayStr(),
    note: "link-src",
    ledgerId: familyLedger,
  });
  const t2 = await api(hA, "POST", "/api/v1/transactions", {
    accountId,
    categoryId: expenseCat,
    type: "expense",
    amount: 66,
    currency: "CNY",
    date: todayStr(),
    note: "link-tgt",
    ledgerId: familyLedger,
  });
  const link = await api(hB, "POST", "/api/v1/transactions/link", {
    sourceId: t1.json().item.id,
    targetId: t2.json().item.id,
    ledgerId: familyLedger,
  });
  assert.equal(link.statusCode, 403, "viewer 关联流水应 403: " + link.body);
});

test("普通 member 不能修改/删除其他成员流水，只能改自己的；owner 可改任意", async () => {
  // 把 B 恢复为 member
  await api(hA, "PATCH", `/api/v1/families/${familyId}/members/${idB}`, { role: "member" });

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

  // B（member）尝试把 A 的流水作为 source 关联到别的流水 → 403（source 归属检查）
  const targetForLink = await api(hA, "POST", "/api/v1/transactions", {
    accountId,
    categoryId: expenseCat,
    type: "expense",
    amount: 88,
    currency: "CNY",
    date: todayStr(),
    note: "link-target",
    ledgerId: familyLedger,
  });
  const linkOtherSource = await api(hB, "POST", "/api/v1/transactions/link", {
    sourceId: txAId,
    targetId: targetForLink.json().item.id,
    ledgerId: familyLedger,
  });
  assert.equal(linkOtherSource.statusCode, 403, "member 关联他人 source 应 403: " + linkOtherSource.body);

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

  // B 删自己的 → 200
  const delOwn = await api(hB, "DELETE", `/api/v1/transactions/${txBId}?ledgerId=${familyLedger}`);
  assert.equal(delOwn.statusCode, 200, "member 应能删自己的流水: " + delOwn.body);

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

  // 找 A 的个人账本
  const ledgersRes = await api(hA, "GET", "/api/v1/ledgers");
  const personal = (ledgersRes.json().items as Array<{ id: string; familyId: string | null }>).find((l) => l.familyId === null);
  assert.ok(personal, "A 应有个人账本");
  personalLedgerA = personal!.id;

  // A 在个人账本建分类预算
  const personalCats = await api(hA, "GET", "/api/v1/categories?ledgerId=" + personalLedgerA);
  const personalCat = (personalCats.json().items as Array<{ id: string; type: string }>).find((c) => c.type === "expense");
  assert.ok(personalCat);
  const b1 = await api(hA, "POST", "/api/v1/budgets", { year, month, categoryId: personalCat!.id, amount: 1000, ledgerId: personalLedgerA });
  assert.equal(b1.statusCode, 200, "个人账本预算: " + b1.body);

  // A 在家庭账本（不同 ledger）建同月同分类预算 → 不应 500，而应成功
  const b2 = await api(hA, "POST", "/api/v1/budgets", { year, month, categoryId: expenseCat, amount: 2000, ledgerId: familyLedger });
  assert.equal(b2.statusCode, 200, "家庭账本同分类预算应成功而不是 500: " + b2.body);

  // 数据库层确认确实存在多行（不同 ledger）
  const rows = db
    .select()
    .from(budgets)
    .where(eq(budgets.year, year), eq(budgets.month, month))
    .all();
  assert.ok(rows.length >= 2, "个人与家庭账本应各有独立预算行");
});

test("跨币种转账/还款被明确拒绝", async () => {
  // 同账本内建一个外币账户
  const fxAcc = await api(hA, "POST", "/api/v1/accounts", { name: "美元户", type: "bank", currency: "USD", ledgerId: familyLedger });
  assert.equal(fxAcc.statusCode, 200, fxAcc.body);
  const fxId = fxAcc.json().item.id;

  // 跨币种转账 → 400 CURRENCY_MISMATCH
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

  // 流水币种与账户币种不一致 → 400
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
  // 家庭账本里已有多条 A/B 的流水
  const beforeDel = await api(hA, "GET", `/api/v1/transactions?ledgerId=${familyLedger}`);
  assert.equal(beforeDel.statusCode, 200, beforeDel.body);
  assert.ok(beforeDel.json().items.length > 0, "删除前应有流水");

  // 删除家庭
  const del = await api(hA, "DELETE", `/api/v1/families/${familyId}`);
  assert.equal(del.statusCode, 200, del.body);

  // 原 owner 不能再访问旧家庭账本
  const afterDel = await api(hA, "GET", `/api/v1/transactions?ledgerId=${familyLedger}`);
  assert.equal(afterDel.statusCode, 404, "删除后原 owner 不应再访问旧家庭账本: " + afterDel.body);

  // 原 owner 的 /ledgers 不应再列出旧家庭账本
  const ledgersAfter = await api(hA, "GET", "/api/v1/ledgers");
  const listed = (ledgersAfter.json().items as Array<{ id: string }>).map((l) => l.id);
  assert.ok(!listed.includes(familyLedger), "ledgers 不应包含已删除的家庭账本");
  // 应列出个人账本且标记为 current
  const current = (ledgersAfter.json().items as Array<{ id: string; isCurrent: boolean }>).find((l) => l.isCurrent);
  assert.ok(current, "应有一个当前账本");
  assert.equal(current!.id, personalLedgerA, "当前账本应回退到个人默认账本");

  // 数据层：家庭账本被软删除（deletedAt 非空），且历史财务数据仍保留
  const ledgerRow = db.select().from(ledgers).where(eq(ledgers.id, familyLedger)).get();
  assert.ok(ledgerRow, "家庭账本行应保留");
  assert.ok(ledgerRow!.deletedAt, "家庭账本应标记 deletedAt");
  const txRows = db.select().from(transactions).where(eq(transactions.ledgerId, familyLedger)).all();
  assert.ok(txRows.length > 0, "删除家庭后的历史流水应保留（软删除策略）");
});
