// 输入护栏回归：
//   1) 不存在的日期（2026-02-31）过去只过正则，会被 parseDateStr 静默滚成 3 月 3 日
//   2) ?month=13 / ?year=abc 过去返回 200 + 空统计，掩盖参数错误
//   3) 退化贷款（本金 < 期数）过去能建出来，计划表全是 0 元，「还清」时本金分文未动
//   4) 0 利率贷款的利息腿为 0 元：不应再写 0 元流水（且 0 元流水已被 DB CHECK 拒绝）
process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { amortizationSchedule, monthlyPayment } from "../src/lib/loan.js";
import { transactions } from "../src/db/schema.js";
import { smsRegister } from "./helpers.js";

let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;
let H: Record<string, string>;
let accountId = "";
let categoryId = "";

function req(method: string, url: string, body?: unknown) {
  const h = { ...H };
  if (body !== undefined) h["content-type"] = "application/json";
  return app.inject({ method, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-input-guards-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "input-guards-secret-0123456789" });
  const reg = await smsRegister(app, "13844440001", "输入护栏用户");
  H = { authorization: "Bearer " + reg.token };
  const acct = await req("POST", "/api/v1/accounts", { name: "主账户", type: "bank", currency: "CNY", initialBalance: 100000000 });
  assert.equal(acct.statusCode, 200, acct.body);
  accountId = acct.json().item.id as string;
  const cats = await req("GET", "/api/v1/categories");
  assert.equal(cats.statusCode, 200, cats.body);
  categoryId = (cats.json().items as Array<{ id: string; type: string }>).find((c) => c.type === "expense")!.id;
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("日期校验：不存在的日期被拒绝（不再被静默滚到下个月）", async () => {
  // 2026-02-31 / 2025-02-29（非闰年）/ 2026-04-31 / 2026-13-01 都必须 400
  for (const bad of ["2026-02-31", "2025-02-29", "2026-04-31", "2026-13-01", "2026-00-10"]) {
    const res = await req("POST", "/api/v1/transactions", {
      accountId, categoryId, type: "expense", amount: 100, currency: "CNY", date: bad,
    });
    assert.equal(res.statusCode, 400, `${bad} 应被拒绝: ` + res.body);
    assert.equal(res.json().error.code, "VALIDATION", bad + " 应返回 VALIDATION");
    assert.match(res.json().error.message, /日期/, bad + " 的报错必须是日期本身（否则等于没测到日期校验）");
  }
  // 合法日期（含闰年 2 月 29）必须照常通过
  for (const good of ["2024-02-29", "2026-02-28", "2026-12-31"]) {
    const res = await req("POST", "/api/v1/transactions", {
      accountId, categoryId, type: "expense", amount: 100, currency: "CNY", date: good,
    });
    assert.equal(res.statusCode, 200, `${good} 应被接受: ` + res.body);
  }
  // 贷款的 startDate 同样受保护（还款日不再错位）
  const loan = await req("POST", "/api/v1/loans", {
    name: "坏日期贷款", type: "car", currency: "CNY", principal: 120000,
    annualRate: 0, termMonths: 12, startDate: "2026-02-31",
  });
  assert.equal(loan.statusCode, 400, "贷款起始日不合法应 400: " + loan.body);

  // 周期性账单的 startDate/endDate 同样受保护
  const recurring = await req("POST", "/api/v1/recurring", {
    accountId, type: "expense", amount: 100, frequency: "monthly",
    startDate: "2026-02-31",
  });
  assert.equal(recurring.statusCode, 400, "周期账单起始日不合法应 400: " + recurring.body);
});

test("year/month 查询参数：非法值返回 400 而不是空统计", async () => {
  for (const q of ["month=13", "month=0", "month=abc", "year=abc", "year=0"]) {
    const res = await req("GET", `/api/v1/stats/summary?${q}`);
    assert.equal(res.statusCode, 400, `${q} 应 400: ` + res.body);
  }
  const budgets = await req("GET", "/api/v1/budgets?month=13");
  assert.equal(budgets.statusCode, 400, "预算接口同样应 400: " + budgets.body);
  // 合法值与缺省值仍照常工作
  assert.equal((await req("GET", "/api/v1/stats/summary?year=2026&month=2")).statusCode, 200);
  assert.equal((await req("GET", "/api/v1/stats/summary")).statusCode, 200);
  assert.equal((await req("GET", "/api/v1/budgets?year=2026&month=1")).statusCode, 200);
});

test("退化贷款（本金 < 期数）被拒绝：不再产生「每期 0 元」的计划表", async () => {
  const res = await req("POST", "/api/v1/loans", {
    name: "一分钱分 36 期", type: "car", currency: "CNY", principal: 36,
    annualRate: 0, termMonths: 37, startDate: "2026-01-01",
  });
  assert.equal(res.statusCode, 400, "本金小于期数应 400: " + res.body);
  assert.equal(res.json().error.code, "LOAN_AMOUNT_TOO_SMALL");

  // 边界：本金 == 期数（每期 1 分）可以建，且计划表每期都 > 0
  const ok = await req("POST", "/api/v1/loans", {
    name: "每期一分", type: "car", currency: "CNY", principal: 36,
    annualRate: 0, termMonths: 36, startDate: "2026-01-01",
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const schedule = (await req("GET", "/api/v1/loans/" + ok.json().item.id)).json().schedule as Array<{
    principalDue: number; total: number;
  }>;
  assert.equal(schedule.length, 36);
  assert.ok(schedule.every((s) => s.principalDue > 0 && s.total > 0), "每期本金与总额都必须 > 0");
  assert.equal(schedule[35]!.principalDue, 1, "最后一期收口剩余本金");
});

test("计划表取整收口：本金除以期数除不尽时，最后一期补齐余额", () => {
  // 100000 分 / 12 期：每期 8333 分，前 11 期共 91663，最后一期须补 8337
  const schedule = amortizationSchedule(100000, 0, 12, "2026-01-01");
  assert.equal(schedule.reduce((s, x) => s + x.principalPart, 0), 100000, "本金部分之和必须等于本金");
  assert.equal(schedule[schedule.length - 1]!.remaining, 0, "最后一期后剩余本金必须为 0");
  for (const x of schedule) assert.ok(x.principalPart > 0, "每期本金都必须 > 0");

  // 有息贷款同样收口（浮点/取整余数不能留在计划表外）
  const withInterest = amortizationSchedule(100000, 4.9, 12, "2026-01-01");
  assert.equal(withInterest.reduce((s, x) => s + x.principalPart, 0), 100000);
  assert.equal(withInterest[withInterest.length - 1]!.remaining, 0);

  // 月供下限 1 分（历史缺陷：principal=1、36 期 → 月供 0，整张表都是 0 元）
  assert.equal(monthlyPayment(1, 0, 36) >= 1, true, "月供不得为 0");
  assert.equal(monthlyPayment(0, 5, 12), 0, "本金为 0 时月供仍为 0");
});

test("0 利率贷款还款：只写本金腿，不产生 0 元利息流水", async () => {
  const loan = await req("POST", "/api/v1/loans", {
    name: "零利率贷款", type: "car", currency: "CNY", principal: 24000,
    annualRate: 0, termMonths: 12, startDate: "2026-01-01", accountId,
  });
  assert.equal(loan.statusCode, 200, loan.body);
  const loanId = loan.json().item.id as string;
  const pay = await req("POST", `/api/v1/loans/${loanId}/pay`, {
    payFromAccountId: accountId, idempotencyKey: "zero-rate-pay-1",
  });
  assert.equal(pay.statusCode, 200, pay.body);
  assert.ok(pay.json().principalTransactionId, "应有本金转账流水");
  assert.equal(pay.json().interestTransactionId, null, "0 利率不应生成利息流水");

  const rows = db.select().from(transactions).where(eq(transactions.paymentGroupId, pay.json().paymentGroupId as string)).all();
  assert.equal(rows.length, 1, "0 利率贷款每期只有 1 条流水");
  assert.equal(rows[0]!.type, "transfer");
  assert.ok(rows[0]!.amount > 0);

  // 有息贷款仍然是「本金 + 利息」两条腿
  const loan2 = await req("POST", "/api/v1/loans", {
    name: "有息贷款", type: "car", currency: "CNY", principal: 24000,
    annualRate: 6, termMonths: 12, startDate: "2026-01-01", accountId,
  });
  assert.equal(loan2.statusCode, 200, loan2.body);
  const pay2 = await req("POST", `/api/v1/loans/${loan2.json().item.id}/pay`, {
    payFromAccountId: accountId, idempotencyKey: "interest-pay-1",
  });
  assert.equal(pay2.statusCode, 200, pay2.body);
  assert.ok(pay2.json().principalTransactionId && pay2.json().interestTransactionId, "有息贷款应返回两条流水 id");
  const rows2 = db.select().from(transactions).where(eq(transactions.paymentGroupId, pay2.json().paymentGroupId as string)).all();
  assert.equal(rows2.length, 2, "有息贷款每期 2 条流水");
});
