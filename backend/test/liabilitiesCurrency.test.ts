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
import { accounts, loans } from "../src/db/schema.js";
import { randomUUID } from "node:crypto";
import { smsRegister } from "./helpers.js";

// 负债口径回归（Phase 1）：
// 历史缺陷：/liabilities 把"账户原币"的信用卡欠款与"贷款原币"的剩余本金直接累加进
// 基准币的 totalDebt；而 /stats/summary 的信用卡部分又是按汇率折算的 —— 同一账本的
// "总负债"在两个接口上给出不同数字（实测 USD 卡 500 美元 + CNY 卡 300 元：
// /liabilities=80000 分，/stats/summary=390000 分）。
// 不变量：两个接口的 totalDebt 必须相等，且等于各币种按汇率折算后的和。
let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;
let H: Record<string, string>;
let userId = "";

function req(method: string, url: string, body?: unknown) {
  const h = { ...H };
  if (body !== undefined) h["content-type"] = "application/json";
  return app.inject({ method, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
}

const USD_RATE = 7.2; // 内置兜底汇率（USD → CNY）

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-liab-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "liabilities-secret-0123456789" });

  const reg = await smsRegister(app, "13822220001", "负债口径用户");
  userId = reg.user.id;
  H = { authorization: "Bearer " + reg.token };
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("外币信用卡欠款与外币贷款：两个接口的总负债必须一致且按汇率折算", async () => {
  // USD 信用卡欠款 $500.00 = 50000 分
  const usdCc = await req("POST", "/api/v1/accounts", {
    name: "美元信用卡", type: "credit", currency: "USD", initialBalance: -50000,
  });
  assert.equal(usdCc.statusCode, 200, usdCc.body);
  // CNY 信用卡欠款 ¥300.00 = 30000 分
  const cnyCc = await req("POST", "/api/v1/accounts", {
    name: "人民币信用卡", type: "credit", currency: "CNY", initialBalance: -30000,
  });
  assert.equal(cnyCc.statusCode, 200, cnyCc.body);
  // USD 信用卡额外消费 10000 分（$100）→ 合计 $600
  const cats = (await req("GET", "/api/v1/categories")).json().items as Array<{ id: string; type: string }>;
  const expenseCat = cats.find((c) => c.type === "expense")!.id;
  const spend = await req("POST", "/api/v1/transactions", {
    type: "expense", amount: 10000, date: "2025-01-10",
    accountId: usdCc.json().item.id, currency: "USD", categoryId: expenseCat,
  });
  assert.equal(spend.statusCode, 200, spend.body);

  // USD 贷款 $1000.00 = 100000 分
  const loan = await req("POST", "/api/v1/loans", {
    name: "美元车贷", type: "car", currency: "USD", principal: 100000,
    annualRate: 0, termMonths: 12, startDate: "2025-01-01",
  });
  assert.equal(loan.statusCode, 200, loan.body);

  const expectedCredit = Math.round(60000 * USD_RATE) + 30000; // $600 + ¥300
  const expectedLoan = Math.round(100000 * USD_RATE); // $1000
  const expectedTotal = expectedCredit + expectedLoan;

  const summary = (await req("GET", "/api/v1/stats/summary?year=2025&month=1")).json();
  const liabilities = (await req("GET", "/api/v1/liabilities")).json();

  assert.equal(liabilities.totalDebt, expectedTotal, "/liabilities 总负债应为折算后的和: " + JSON.stringify(liabilities));
  assert.equal(summary.totalDebt, expectedTotal, "/stats/summary 总负债应为折算后的和: " + JSON.stringify(summary));
  assert.equal(liabilities.totalDebt, summary.totalDebt, "同一账本的总负债在两个接口上必须相等");
  assert.equal(liabilities.baseCurrency, "CNY", "应显式声明基准币");

  // 明细字段也必须是基准币口径
  const usdCard = (liabilities.creditCards as Array<{ name: string; debt: number; currency: string }>).find(
    (c) => c.name === "美元信用卡",
  )!;
  assert.equal(usdCard.debt, Math.round(60000 * USD_RATE), "信用卡 debt 必须是基准币金额");
  const usdLoan = (liabilities.loans as Array<{ name: string; remainingPrincipal: number }>).find(
    (l) => l.name === "美元车贷",
  )!;
  assert.equal(usdLoan.remainingPrincipal, expectedLoan, "贷款剩余本金必须是基准币金额");
});

test("/accounts 的 debt 字段同样按基准币返回（客户端用它算净资产）", async () => {
  const list = (await req("GET", "/api/v1/accounts")).json().items as Array<{
    name: string; currency: string; balance: number; debt: number;
  }>;
  const usdCard = list.find((a) => a.name === "美元信用卡")!;
  assert.equal(usdCard.currency, "USD");
  assert.equal(usdCard.balance, -60000, "balance 保持账户本位币口径（供账户详情展示）");
  assert.equal(usdCard.debt, Math.round(60000 * USD_RATE), "debt 必须是基准币，便于跨账户求和");
});

test("未知币种仍按 1:1 兜底，不崩溃（既有容错语义保留）", async () => {
  // API 已禁止写入非法币种，这里直接落库模拟历史脏数据
  const now = new Date().toISOString();
  const ledgerId = sqlite.prepare("SELECT current_ledger_id AS id FROM users WHERE id = ?").get(userId)!.id as string;
  db.insert(accounts)
    .values({
      id: randomUUID(), ledgerId, userId, name: "历史脏币种卡", type: "credit",
      currency: "XXX", initialBalance: -12345, isArchived: false, createdAt: now, updatedAt: now,
    })
    .run();

  const liabilities = (await req("GET", "/api/v1/liabilities")).json();
  const junk = (liabilities.creditCards as Array<{ name: string; debt: number }>).find((c) => c.name === "历史脏币种卡")!;
  assert.equal(junk.debt, 12345, "未知币种按 1:1 兜底（不崩溃、不抛错）");

  const summary = (await req("GET", "/api/v1/stats/summary?year=2025&month=1")).json();
  assert.equal(liabilities.totalDebt, summary.totalDebt, "含未知币种时两个接口仍必须一致");
});

test("历史小写币种的数据按大写归一后参与折算（读侧兼容）", async () => {
  const now = new Date().toISOString();
  const ledgerId = sqlite.prepare("SELECT current_ledger_id AS id FROM users WHERE id = ?").get(userId)!.id as string;
  db.insert(loans)
    .values({
      id: randomUUID(), ledgerId, userId, name: "历史小写贷款", type: "other", currency: "usd",
      principal: 50000, remainingPrincipal: 50000, annualRate: 0, termMonths: 12, monthlyPayment: 0,
      startDate: "2025-01-01", nextPaymentDate: "2025-02-01", status: "active",
      accountId: null, liabilityAccountId: null, createdAt: now, updatedAt: now,
    })
    .run();
  const liabilities = (await req("GET", "/api/v1/liabilities")).json();
  const lower = (liabilities.loans as Array<{ name: string; remainingPrincipal: number }>).find(
    (l) => l.name === "历史小写贷款",
  )!;
  assert.equal(lower.remainingPrincipal, Math.round(50000 * USD_RATE), "小写 usd 必须按 USD 汇率折算，而不是 1:1");
});
