// 负债域护栏回归：
// 这些缺陷此前全部没有测试覆盖（197 个测试全绿但都能被复现），因此单独立一个文件锁死。
//   1) 信用卡账单「取消已还」→ 再次 /pay 重复生成还款转账（重复扣款、信用卡变溢缴）
//   2) PATCH 空 body → drizzle set({}) 抛错 → 500（应为 400）
//   3) 归档信用卡后 /liabilities 与 /stats/summary 的 totalDebt 口径分裂
//   4) DELETE /loans/:id 删不干净：留下没有任何贷款对应的 loan 类型负债账户
//   5) /liabilities 的 monthlyPayment / 信用卡账单金额未折算基准币（$500 显示成 ¥500）
//   6) 信用卡还款允许用 loan 类型负债账户作还款来源
//   7) 幂等兜底按「索引名」匹配 SQLite 报错文本 → 分支永不命中（真并发返回 500）
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
import { getRate } from "../src/lib/currency.js";
import { isUniqueViolation } from "../src/lib/sqliteErrors.js";
import { accounts, transactions } from "../src/db/schema.js";
import { smsRegister } from "./helpers.js";

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

async function newCard(name: string, currency = "CNY", debt = 0) {
  const res = await req("POST", "/api/v1/accounts", {
    name, type: "credit", currency, initialBalance: debt === 0 ? 0 : -debt, creditLimit: 5000000,
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().item.id as string;
}

async function newBank(name = "还款卡", currency = "CNY") {
  const res = await req("POST", "/api/v1/accounts", { name, type: "bank", currency, initialBalance: 100000000 });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().item.id as string;
}

async function newBill(accountId: string, period: string, statementBalance: number) {
  const res = await req("POST", `/api/v1/credit-cards/${accountId}/bills`, {
    period, statementBalance, minimumPayment: 1000, dueDate: `${period}-25`,
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().item.id as string;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-liab-guards-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "liability-guards-secret-0123456789" });
  const reg = await smsRegister(app, "13833330001", "负债护栏用户");
  userId = reg.user.id;
  H = { authorization: "Bearer " + reg.token };
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("信用卡账单：取消已还被拒绝，且永远只生成一笔还款转账", async () => {
  const cardId = await newCard("护栏信用卡");
  const bankId = await newBank();
  const billId = await newBill(cardId, "2026-03", 10000);

  // 未还账单：直接标记已还必须被拒（要走 /pay 生成转账）
  const markPaid = await req("PATCH", `/api/v1/credit-card-bills/${billId}`, { paid: true });
  assert.equal(markPaid.statusCode, 400, markPaid.body);

  // 空 body：历史缺陷是 drizzle set({}) 抛 "No values to set" → 500
  const empty = await req("PATCH", `/api/v1/credit-card-bills/${billId}`, {});
  assert.equal(empty.statusCode, 400, "空 PATCH 应为 400 而不是 500: " + empty.body);
  assert.equal(empty.json().error.code, "NOTHING_TO_UPDATE");

  // 未还账单重复提交 paid:false 是幂等空操作（不写库、不报错）
  const noop = await req("PATCH", `/api/v1/credit-card-bills/${billId}`, { paid: false });
  assert.equal(noop.statusCode, 200, noop.body);

  const pay1 = await req("POST", `/api/v1/credit-card-bills/${billId}/pay`, { payFromAccountId: bankId });
  assert.equal(pay1.statusCode, 200, pay1.body);

  // 核心回归：取消已还必须被拒绝（否则再还一次就是重复扣款）
  const unpay = await req("PATCH", `/api/v1/credit-card-bills/${billId}`, { paid: false });
  assert.equal(unpay.statusCode, 400, "已还账单不能取消标记: " + unpay.body);
  assert.equal(unpay.json().error.code, "BILL_PAID_IMMUTABLE");

  // 已还账单再发 paid:true 是幂等空操作
  const paidAgain = await req("PATCH", `/api/v1/credit-card-bills/${billId}`, { paid: true });
  assert.equal(paidAgain.statusCode, 200, paidAgain.body);

  // 再还款仍然是 409，且还款转账只有一笔
  const pay2 = await req("POST", `/api/v1/credit-card-bills/${billId}/pay`, { payFromAccountId: bankId });
  assert.equal(pay2.statusCode, 409, "重复还款应 409: " + pay2.body);
  const transfers = db.select().from(transactions).where(eq(transactions.sourceType, "credit-payment")).all();
  assert.equal(transfers.length, 1, "同一账单只允许一笔还款转账");
});

test("信用卡还款不允许用 loan 类型负债账户作还款来源", async () => {
  const bankId = await newBank("来源卡2");
  const loan = await req("POST", "/api/v1/loans", {
    name: "护栏车贷", type: "car", currency: "CNY", principal: 120000,
    annualRate: 0, termMonths: 12, startDate: "2026-01-01", accountId: bankId,
  });
  assert.equal(loan.statusCode, 200, loan.body);
  const liabilityAccountId = loan.json().item.liabilityAccountId as string;
  assert.ok(liabilityAccountId, "贷款应自动创建负债账户");

  const cardId = await newCard("护栏信用卡2");
  const billId = await newBill(cardId, "2026-03", 5000);
  const pay = await req("POST", `/api/v1/credit-card-bills/${billId}/pay`, { payFromAccountId: liabilityAccountId });
  assert.equal(pay.statusCode, 400, "loan 账户不能作为还款来源: " + pay.body);
  assert.equal(pay.json().error.code, "INVALID_PAY_ACCOUNT");
});

test("归档信用卡：/liabilities 与 /stats/summary 的 totalDebt 必须一致", async () => {
  const cardId = await newCard("待归档卡", "CNY", 6789);
  const before = {
    liabilities: (await req("GET", "/api/v1/liabilities")).json(),
    summary: (await req("GET", "/api/v1/stats/summary")).json(),
  };
  assert.ok(before.liabilities.totalDebt >= 6789, before.liabilities);
  assert.equal(before.liabilities.totalDebt, before.summary.totalDebt, "归档前两个接口必须一致");

  const archived = await req("DELETE", `/api/v1/accounts/${cardId}`);
  assert.equal(archived.statusCode, 200, archived.body);

  const after = {
    liabilities: (await req("GET", "/api/v1/liabilities")).json(),
    summary: (await req("GET", "/api/v1/stats/summary")).json(),
  };
  // 归档后该卡既不该算进 /liabilities，也不该算进 /stats/summary
  assert.equal(
    after.liabilities.totalDebt,
    before.liabilities.totalDebt - 6789,
    "归档卡不应再计入 /liabilities.totalDebt: " + JSON.stringify(after.liabilities),
  );
  assert.equal(
    after.liabilities.totalDebt,
    after.summary.totalDebt,
    "归档后两个接口的 totalDebt 仍必须相等（历史缺陷：6789 vs 0）",
  );
});

test("删除贷款：清理还款计划与幂等记录、归档负债账户、写审计，统计口径保持一致", async () => {
  const bankId = await newBank("还款卡3");
  const created = await req("POST", "/api/v1/loans", {
    name: "待删贷款", type: "car", currency: "CNY", principal: 120000,
    annualRate: 4.5, termMonths: 12, startDate: "2026-01-01", accountId: bankId,
  });
  assert.equal(created.statusCode, 200, created.body);
  const loanId = created.json().item.id as string;
  const liabilityAccountId = created.json().item.liabilityAccountId as string;

  // 先还一期，确保「已产生还款流水/幂等记录」的贷款也能被正确删除
  const pay = await req("POST", `/api/v1/loans/${loanId}/pay`, {
    payFromAccountId: bankId, idempotencyKey: "guard-delete-pay-1",
  });
  assert.equal(pay.statusCode, 200, pay.body);

  const del = await req("DELETE", `/api/v1/loans/${loanId}`);
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(del.json().liabilityAccountArchived, true, "删除贷款应同时归档它的负债账户");

  // 负债账户必须已归档（否则 /accounts 会留下一笔没有贷款对应的活跃负债账户）
  const acctRow = db.select().from(accounts).where(eq(accounts.id, liabilityAccountId)).get();
  assert.equal(acctRow?.isArchived, true, "负债账户应被归档");

  // 统计口径一致，且不再有这笔贷款的负债
  const liabilities = (await req("GET", "/api/v1/liabilities")).json();
  const summary = (await req("GET", "/api/v1/stats/summary")).json();
  assert.equal(liabilities.totalDebt, summary.totalDebt, "删除后两个接口必须一致");
  assert.equal(
    (liabilities.loans as Array<{ id: string }>).filter((l) => l.id === loanId).length,
    0,
    "被删贷款不应再出现在 /liabilities",
  );

  // 还款流水（真实资金流水）必须保留，不随贷款删除而消失
  const loanTxs = db.select().from(transactions).where(eq(transactions.sourceType, "loan-payment")).all();
  assert.ok(loanTxs.length >= 1, "历史还款流水必须保留");

  // 审计留痕
  const logs = (await req("GET", "/api/v1/audit-logs?entityType=loan")).json().items as Array<{
    entityId: string; action: string;
  }>;
  assert.ok(
    logs.some((l) => l.entityId === loanId && l.action === "loan_delete"),
    "删除贷款必须写审计: " + JSON.stringify(logs),
  );
});

test("/liabilities 的月供与信用卡账单金额按基准币折算（原币值走 *Native）", async () => {
  const rate = getRate(db, userId, "USD", "CNY");
  const usdCardId = await newCard("美元卡-折算", "USD", 60000);
  const billId = await newBill(usdCardId, "2026-04", 50000); // $500.00
  const usdLoan = await req("POST", "/api/v1/loans", {
    name: "美元车贷-折算", type: "car", currency: "USD", principal: 100000,
    annualRate: 0, termMonths: 10, startDate: "2026-01-01",
  });
  assert.equal(usdLoan.statusCode, 200, usdLoan.body);

  const liabilities = (await req("GET", "/api/v1/liabilities")).json();

  const bill = (liabilities.creditCardBills as Array<{
    id: string; currency: string; statementBalance: number; statementBalanceNative: number; minimumPayment: number;
  }>).find((b) => b.id === billId)!;
  assert.ok(bill, "应能查到该账单");
  assert.equal(bill.currency, "USD");
  assert.equal(bill.statementBalanceNative, 50000, "原币值保留在 *Native 字段");
  assert.equal(bill.statementBalance, Math.round(50000 * rate), "$500 账单必须折算成基准币（历史缺陷：原样返回）");
  assert.equal(bill.minimumPayment, Math.round(1000 * rate), "最低还款额同样折算");

  const loan = (liabilities.loans as Array<{
    name: string; monthlyPayment: number; monthlyPaymentNative: number;
  }>).find((l) => l.name === "美元车贷-折算")!;
  assert.ok(loan, "应能查到该贷款");
  assert.equal(loan.monthlyPaymentNative, 10000, "$1000 本金 / 10 期的原币月供");
  assert.equal(loan.monthlyPayment, Math.round(10000 * rate), "月供同样必须折算成基准币");
});

test("幂等兜底判定：SQLite 唯一约束报错只含列名，不含索引名", () => {
  // 复刻 uniq_tx_client_request 的形状：唯一索引名不会出现在 SQLite 的报错文本里
  sqlite.exec("CREATE TABLE probe_unique (ledger_id TEXT, client_request_id TEXT)");
  sqlite.exec(
    "CREATE UNIQUE INDEX uniq_probe_client_request ON probe_unique(ledger_id, client_request_id) " +
      "WHERE client_request_id IS NOT NULL",
  );
  sqlite.prepare("INSERT INTO probe_unique VALUES (?, ?)").run("L1", "R1");
  let caught: unknown;
  try {
    sqlite.prepare("INSERT INTO probe_unique VALUES (?, ?)").run("L1", "R1");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "重复插入必须抛错");
  const err = caught as Error & { code?: string };
  assert.equal(err.code, "SQLITE_CONSTRAINT_UNIQUE");
  assert.ok(
    !err.message.includes("uniq_probe_client_request"),
    "报错文本不含索引名（这正是旧的 message.includes(索引名) 判定失效的原因）：" + err.message,
  );
  assert.ok(err.message.includes("client_request_id"), "报错文本含列名：" + err.message);
  // 正确判定
  assert.equal(isUniqueViolation(caught), true);
  assert.equal(isUniqueViolation(caught, ["client_request_id"]), true);
  assert.equal(isUniqueViolation(caught, ["some_other_column"]), false, "列名不符时不应误判");
  assert.equal(isUniqueViolation(new Error("UNIQUE constraint failed: x")), false, "非 sqlite 错误码不误判");
});
