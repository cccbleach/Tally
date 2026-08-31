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
import { and, asc, eq } from "drizzle-orm";
import { accounts, loans, loanPayments, loanPaymentIdempotency, transactions, auditLogs } from "../src/db/schema.js";
import { smsRegister, authHeaders } from "./helpers.js";

process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";

let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;
let headers: Record<string, string> = {};
let ledgerId: string;
let bankId: string;
let expenseCatId: string;

function req(method: string, url: string, body?: unknown) {
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
  dir = mkdtempSync(join(tmpdir(), "tally-loan-atomic-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "test-secret" });

  const reg = await smsRegister(app, "13841000001", "贷款测试");
  headers = authHeaders(reg);
  // 取默认/当前账本作为 ledgerId
  const ledgersResp = await req("GET", "/api/v1/ledgers");
  const def = (ledgersResp.json().items as Array<{ id: string; isCurrent: boolean }>).find((l) => l.isCurrent);
  ledgerId = def!.id;
  const acc = await req("POST", "/api/v1/accounts", { name: "工资卡", type: "bank", currency: "CNY" });
  bankId = acc.json().item.id;
  const cats = await req("GET", "/api/v1/categories");
  const expense = (cats.json().items as Array<{ id: string; type: string }>).find((c) => c.type === "expense");
  expenseCatId = expense!.id;
});

after(() => {
  // 清理可能残留的触发器
  try { sqlite.exec("DROP TRIGGER IF EXISTS fail_loan_insert"); } catch {}
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("贷款创建时负债账户/贷款/还款计划/审计日志在同一事务；INSERT 失败无孤儿账户", async () => {
  // 第一次正常创建：验证四类数据在“成功路径”都生成
  const okCreate = await req("POST", "/api/v1/loans", {
    name: "车贷",
    type: "car",
    principal: 100000,
    annualRate: 4,
    termMonths: 12,
    startDate: todayStr(),
    ledgerId,
  });
  assert.equal(okCreate.statusCode, 200, okCreate.body);
  const liabilityId = okCreate.json().item.liabilityAccountId as string;
  assert.ok(liabilityId);
  const liab = db.select().from(accounts).where(eq(accounts.id, liabilityId)).get();
  assert.ok(liab && liab.type === "loan", "应创建 loan 类型负债账户");
  const loanCount = db.select().from(loans).all().length;
  assert.equal(loanCount, 1, "应有 1 条贷款");
  const schCount = db.select().from(loanPayments).all();
  assert.equal(schCount.length, 12, "应有 12 期还款计划");
  const audit = db.select().from(auditLogs).where(eq(auditLogs.action, "loan_create")).all();
  assert.equal(audit.length, 1, "应有 loan_create 审计日志");

  // 强制 loans INSERT 失败（BEFORE INSERT 触发器 RAISE(ABORT)）
  const beforeAccounts = db.select().from(accounts).all().length;
  sqlite.exec(
    "CREATE TRIGGER fail_loan_insert BEFORE INSERT ON loans BEGIN SELECT RAISE(ABORT, 'forced loan insert failure'); END;",
  );
  const failed = await req("POST", "/api/v1/loans", {
    name: "失败贷款",
    type: "other",
    principal: 50000,
    annualRate: 3,
    termMonths: 6,
    startDate: todayStr(),
    ledgerId,
  });
  assert.equal(failed.statusCode, 500, "强制失败应返回 500: " + failed.body);

  // 事务回滚：不应产生孤儿 loan 类型账户、额外 loans/loanPayments/audit 行
  const afterAccounts = db.select().from(accounts).all();
  assert.equal(afterAccounts.length, beforeAccounts, "失败后不应新增账户（含负债账户）");
  const loanCount2 = db.select().from(loans).all().length;
  assert.equal(loanCount2, 1, "不应新增贷款");
  const schCount2 = db.select().from(loanPayments).all().length;
  assert.equal(schCount2, 12, "不应新增还款计划");
  const audit2 = db.select().from(auditLogs).where(eq(auditLogs.action, "loan_create")).all();
  assert.equal(audit2.length, 1, "不应新增 loan_create 审计日志");
  sqlite.exec("DROP TRIGGER fail_loan_insert");
});

async function createLoan(name: string, termMonths: number) {
  const r = await req("POST", "/api/v1/loans", {
    name,
    type: "other",
    principal: termMonths * 2000,
    annualRate: 0,
    termMonths,
    startDate: todayStr(),
    accountId: bankId,
    ledgerId,
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().item as { id: string; liabilityAccountId: string };
}

test("贷款还款幂等：idempotencyKey 重放返回相同结果、不偿还下一期、每期最多一组流水", async () => {
  const { id: loanId } = await createLoan("幂等测试", 3);
  const key = "loan-pay-idem-" + Date.now();

  // 第一次：支付第 1 期
  const first = await req("POST", `/api/v1/loans/${loanId}/pay`, {
    payFromAccountId: bankId,
    ledgerId,
    idempotencyKey: key,
  });
  assert.equal(first.statusCode, 200, first.body);
  const g1 = first.json().paymentGroupId as string;
  assert.equal(first.json().installment, 1);
  const txAfterFirst = db.select().from(transactions).where(eq(transactions.paymentGroupId, g1)).all().length;
  assert.equal(txAfterFirst, 2, "每期还款应恰好生成 2 条流水");

  // 顺序重放：同一 idempotencyKey 应返回相同结果，且不偿还第 2 期
  const replay = await req("POST", `/api/v1/loans/${loanId}/pay`, {
    payFromAccountId: bankId,
    ledgerId,
    idempotencyKey: key,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().replayed, true, "重放应标记 replayed");
  assert.equal(replay.json().paymentGroupId, g1, "重放应返回相同的 paymentGroupId");
  assert.equal(replay.json().installment, 1, "重放不应推进到下一期");

  // 数据层：第 1 期恰好带一组 paymentGroupId、2 条流水；第 2、3 期仍未还
  const g1Tx = db.select().from(transactions).where(eq(transactions.paymentGroupId, g1)).all();
  assert.equal(g1Tx.length, 2, "第 1 期只有一组 2 条流水");
  const schedule = db.select().from(loanPayments).where(eq(loanPayments.loanId, loanId)).orderBy(asc(loanPayments.installmentNo)).all();
  assert.equal(schedule.filter((p) => p.paid).length, 1, "只有第 1 期已还");
  assert.equal(schedule.find((p) => p.installmentNo === 2)!.paid, false, "第 2 期不应被重放误还");

  // 显式 installmentId 重复支付第 1 期（无幂等 key）→ 409
  const dupInstallment = await req("POST", `/api/v1/loans/${loanId}/pay`, {
    payFromAccountId: bankId,
    ledgerId,
    installmentId: schedule.find((p) => p.installmentNo === 1)!.id,
  });
  assert.equal(dupInstallment.statusCode, 409, "显式重复支付同一期应 409: " + dupInstallment.body);
  const txStill = db.select().from(transactions).where(eq(transactions.paymentGroupId, g1)).all().length;
  assert.equal(txStill, 2, "重复支付不应新增流水");
});

test("偿还下一期必须提供 idempotencyKey（无 key 返回 400）", async () => {
  const { id: loanId } = await createLoan("规则测试", 3);
  const noKey = await req("POST", `/api/v1/loans/${loanId}/pay`, {
    payFromAccountId: bankId,
    ledgerId,
  });
  assert.equal(noKey.statusCode, 400, noKey.body);
  assert.match(noKey.body, /IDEMPOTENCY_KEY_REQUIRED/);

  // 带 key 的偿还下一期应正常成功
  const withKey = await req("POST", `/api/v1/loans/${loanId}/pay`, {
    payFromAccountId: bankId,
    ledgerId,
    idempotencyKey: "next-key-" + Date.now(),
  });
  assert.equal(withKey.statusCode, 200, withKey.body);
});

test("只有 1 期的贷款：用 idempotencyKey 偿还最后一期后，完全相同请求重放返回 200/replayed=true/相同 paymentGroupId，而非 LOAN_PAID_OFF", async () => {
  // 只有 1 期的贷款：还清这一期后贷款即进入 paid_off。
  const { id: loanId } = await createLoan("最后一期幂等重放", 1);
  const key = "last-installment-replay-" + Date.now();
  const payBody = {
    payFromAccountId: bankId,
    ledgerId,
    idempotencyKey: key,
  };

  // 第一次：用 idempotencyKey 偿还最后一期（“偿还下一期”模式）→ 成功还款
  const first = await req("POST", `/api/v1/loans/${loanId}/pay`, payBody);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().replayed, false, "首次还款不应 replayed");
  assert.equal(first.json().installment, 1, "应还的是第 1 期（也是最后一期）");
  const groupId = first.json().paymentGroupId as string;
  assert.ok(groupId, "首次还款应返回 paymentGroupId");

  // 贷款此时应已 paid_off，但完全相同请求重放必须命中幂等记录返回原结果，
  // 绝不能因为“下一期未还已不存在”而返回 LOAN_PAID_OFF。
  const loanAfter = db.select().from(loans).where(eq(loans.id, loanId)).get()!;
  assert.equal(loanAfter.status, "paid_off", "还清 1 期贷款后应进入 paid_off");

  // 完全相同请求重放：200、replayed=true、相同 paymentGroupId
  const replay = await req("POST", `/api/v1/loans/${loanId}/pay`, payBody);
  assert.equal(replay.statusCode, 200, "重放必须 200，不得 LOAN_PAID_OFF: " + replay.body);
  assert.equal(replay.json().replayed, true, "重放应 replayed=true");
  assert.equal(replay.json().paymentGroupId, groupId, "重放应返回相同的 paymentGroupId");
  assert.equal(replay.json().installment, 1);

  // 数据层：仍只有 1 条幂等记录、2 条流水、1 期 paid
  const idems = db
    .select()
    .from(loanPaymentIdempotency)
    .where(and(eq(loanPaymentIdempotency.loanId, loanId), eq(loanPaymentIdempotency.idempotencyKey, key)))
    .all();
  assert.equal(idems.length, 1, "应只有一条幂等记录");
  const groupTx = db.select().from(transactions).where(eq(transactions.paymentGroupId, groupId)).all();
  assert.equal(groupTx.length, 2, "应恰好 2 条流水");
  const payments = db.select().from(loanPayments).where(eq(loanPayments.loanId, loanId)).all();
  assert.equal(payments.length, 1, "应有 1 期");
  assert.equal(payments[0]!.paid, true, "该期应已 paid");
});


test("同一 idempotencyKey 不同请求体（不同期次/账户/日期）→ 409 IDEMPOTENCY_KEY_REUSED", async () => {
  const { id: loanId } = await createLoan("复用测试", 3);
  const schedule = db
    .select()
    .from(loanPayments)
    .where(eq(loanPayments.loanId, loanId))
    .orderBy(asc(loanPayments.installmentNo))
    .all();
  const key = "reuse-key-" + Date.now();

  // 第一次：显式还第 1 期
  const first = await req("POST", `/api/v1/loans/${loanId}/pay`, {
    payFromAccountId: bankId,
    ledgerId,
    installmentId: schedule[0]!.id,
    idempotencyKey: key,
  });
  assert.equal(first.statusCode, 200, first.body);

  // 同一 key 还第 2 期（不同期次）→ 409
  const reuseInstallment = await req("POST", `/api/v1/loans/${loanId}/pay`, {
    payFromAccountId: bankId,
    ledgerId,
    installmentId: schedule[1]!.id,
    idempotencyKey: key,
  });
  assert.equal(reuseInstallment.statusCode, 409, reuseInstallment.body);
  assert.match(reuseInstallment.body, /IDEMPOTENCY_KEY_REUSED/);
  const after = db.select().from(loanPayments).where(eq(loanPayments.id, schedule[1]!.id)).get()!;
  assert.equal(after.paid, false, "被 409 拒绝的复用请求不应实际还款");

  // 同一 key 复用为“不同日期” → 409 IDEMPOTENCY_KEY_REUSED
  const reuseDate = await req("POST", `/api/v1/loans/${loanId}/pay`, {
    payFromAccountId: bankId,
    ledgerId,
    installmentId: schedule[0]!.id,
    date: "2030-01-01",
    idempotencyKey: key,
  });
  assert.equal(reuseDate.statusCode, 409, reuseDate.body);
  assert.match(reuseDate.body, /IDEMPOTENCY_KEY_REUSED/);

  // 同一 key 复用为“不同还款账户” → 409 IDEMPOTENCY_KEY_REUSED
  const otherAcc = await req("POST", "/api/v1/accounts", { name: "另一张卡", type: "bank", currency: "CNY", ledgerId });
  const otherBankId = otherAcc.json().item.id as string;
  const reuseAccount = await req("POST", `/api/v1/loans/${loanId}/pay`, {
    payFromAccountId: otherBankId,
    ledgerId,
    installmentId: schedule[0]!.id,
    idempotencyKey: key,
  });
  assert.equal(reuseAccount.statusCode, 409, reuseAccount.body);
  assert.match(reuseAccount.body, /IDEMPOTENCY_KEY_REUSED/);
});

test("两个独立数据库连接：陈旧读取时条件更新 changes=0（同一期不会被重复还款）", async () => {
  const { id: loanId } = await createLoan("双连接测试", 3);
  const file = join(dir, "test.db");
  const connA = createDb(file);
  const connB = createDb(file);
  try {
    const installment = connA.db
      .select()
      .from(loanPayments)
      .where(and(eq(loanPayments.loanId, loanId), eq(loanPayments.paid, false)))
      .orderBy(asc(loanPayments.installmentNo))
      .get()!;
    // 两个连接都“看到”同一期为未还（模拟并发读取同一 next 期）
    const seenA = connA.db.select().from(loanPayments).where(eq(loanPayments.id, installment.id)).get()!;
    const seenB = connB.db.select().from(loanPayments).where(eq(loanPayments.id, installment.id)).get()!;
    assert.equal(seenA.paid, false);
    assert.equal(seenB.paid, false, "两个连接都读到未还（陈旧读取前提）");

    // 连接 A 先胜出：条件更新 paid=false → changes=1
    const win = connA.sqlite
      .prepare("UPDATE loan_payments SET paid=1, status='paid' WHERE id=? AND paid=0")
      .run(installment.id);
    assert.equal(win.changes, 1, "胜者应更新 1 行");

    // 连接 B 落败：条件更新同样 WHERE paid=0 → changes=0（触发 changes 0 分支）
    const lose = connB.sqlite
      .prepare("UPDATE loan_payments SET paid=1, status='paid' WHERE id=? AND paid=0")
      .run(installment.id);
    assert.equal(lose.changes, 0, "败者条件更新应 changes=0，从而走 409 分支");

    // 服务端显式重复支付该期（无幂等 key）→ 409
    const before = db.select().from(transactions).where(eq(transactions.sourceType, "loan-payment")).all().length;
    const dup = await req("POST", `/api/v1/loans/${loanId}/pay`, {
      payFromAccountId: bankId,
      ledgerId,
      installmentId: installment.id,
    });
    assert.equal(dup.statusCode, 409, "已还期次再次支付应 409: " + dup.body);
    // 未生成任何新的还款流水
    const after = db.select().from(transactions).where(eq(transactions.sourceType, "loan-payment")).all().length;
    assert.equal(after, before, "双连接失败路径不应新增任何还款流水");
  } finally {
    connA.sqlite.close();
    connB.sqlite.close();
  }
});

test("信用卡还款使用条件更新：重复还款返回 409 且不产生第二套流水", async () => {
  const card = await req("POST", "/api/v1/accounts", { name: "信用卡", type: "credit", currency: "CNY", ledgerId });
  const cardId = card.json().item.id as string;
  const bill = await req("POST", `/api/v1/credit-cards/${cardId}/bills`, {
    period: "2026-09",
    statementBalance: 1000,
    ledgerId,
  });
  assert.equal(bill.statusCode, 200, bill.body);
  const billId = bill.json().item.id as string;

  const cpay1 = await req("POST", `/api/v1/credit-card-bills/${billId}/pay`, { payFromAccountId: bankId, ledgerId });
  assert.equal(cpay1.statusCode, 200, cpay1.body);
  const txAfterCardPay = db.select().from(transactions).all().length;
  assert.ok(txAfterCardPay >= 1, "信用卡还款应生成转账流水");

  const cpay2 = await req("POST", `/api/v1/credit-card-bills/${billId}/pay`, { payFromAccountId: bankId, ledgerId });
  assert.equal(cpay2.statusCode, 409, "信用卡重复还款应 409: " + cpay2.body);
  const txAfterCardPay2 = db.select().from(transactions).all().length;
  assert.equal(txAfterCardPay2, txAfterCardPay, "信用卡重复还款不应新增流水");
});
