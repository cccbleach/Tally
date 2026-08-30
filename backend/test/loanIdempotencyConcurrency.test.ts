import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { todayStr } from "../src/lib/date.js";
import { and, asc, eq } from "drizzle-orm";
import { loanPaymentIdempotency, loanPayments, transactions } from "../src/db/schema.js";

// 本测试的并发 worker 需要能 require TypeScript 源码，但**不能**继承 tsx 的 ESM loader：
// 否则 Node 会在 worker 内走 ESM loader 的 getSourceSync 读取入口文件，产生
// “File descriptor ... opened/closed in unmanaged mode” 批量告警（Node 24 + tsx 已知现象）。
// 因此 worker 用纯 CommonJS（.cjs）入口，并只注入 tsx 的 CJS require 钩子（tsx/cjs），
// 彻底避开 ESM loader 路径，FD 告警为 0。
const tsxCjsRequireHook = createRequire(import.meta.url).resolve("tsx/cjs");

process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";

const JWT_SECRET = "concurrency-test-secret";
let dir: string;
let dbFile: string;
let workerA: Worker;
let workerB: Worker;
let portA = 0;
let portB = 0;

// user1 的贷款 1（还款期 4 期）——用于并发同 key 测试
let token1 = "";
let ledgerId1 = "";
let bankId1 = "";
let loanId1 = "";
let inst1Id = "";
let firstDue = "";
// user2 的贷款 2——用于跨用户 key 隔离
let token2 = "";
let ledgerId2 = "";
let bankId2 = "";
let loanId2 = "";
let inst2_1 = "";

function req(app: FastifyInstance, method: string, url: string, token: string, body?: unknown) {
  const h: Record<string, string> = { authorization: "Bearer " + token };
  if (body !== undefined) h["content-type"] = "application/json";
  return app.inject({
    method,
    url,
    headers: h,
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedUser(app: FastifyInstance, email: string) {
  const reg = await req(app, "POST", "/api/v1/auth/register", "", {
    email,
    password: "password123",
    displayName: email.split("@")[0],
  });
  assert.equal(reg.statusCode, 200, reg.body);
  const token = reg.json().token as string;
  const ledgers = await req(app, "GET", "/api/v1/ledgers", token);
  const ledgerId = (ledgers.json().items as Array<{ id: string; isCurrent: boolean }>).find((l) => l.isCurrent)!.id;
  const acc = await req(app, "POST", "/api/v1/accounts", token, {
    name: "工资卡-" + email,
    type: "bank",
    currency: "CNY",
    ledgerId,
  });
  assert.equal(acc.statusCode, 200, acc.body);
  const bankId = acc.json().item.id as string;
  return { token, ledgerId, bankId };
}

async function createLoan(
  app: FastifyInstance,
  token: string,
  ledgerId: string,
  bankId: string,
  name: string,
) {
  const r = await req(app, "POST", "/api/v1/loans", token, {
    name,
    type: "other",
    principal: 4 * 2000,
    annualRate: 0,
    termMonths: 4,
    startDate: todayStr(),
    accountId: bankId,
    ledgerId,
  });
  assert.equal(r.statusCode, 200, r.body);
  const item = r.json().item as { id: string };
  const detail = await req(app, "GET", "/api/v1/loans/" + item.id, token);
  assert.equal(detail.statusCode, 200, detail.body);
  const schedule = detail.json().schedule as Array<{ id: string; installmentNo: number; dueDate: string; paid: boolean }>;
  schedule.sort((a, b) => a.installmentNo - b.installmentNo);
  return { loanId: item.id, schedule };
}

function spawnServer(dbFile: string): Promise<{ worker: Worker; port: number }> {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(new URL("./loanConcWorker.cjs", import.meta.url), {
      workerData: { dbFile, jwtSecret: JWT_SECRET },
      // 只注入 tsx 的 CJS require 钩子（不继承 ESM loader），消除 worker 内 FD 告警
      execArgv: ["--require", tsxCjsRequireHook],
    });
    const timer = setTimeout(() => {
      reject(new Error("worker 启动超时"));
    }, 15000);
    worker.once("message", (msg: { ready?: boolean; error?: string; port?: number }) => {
      clearTimeout(timer);
      if (msg?.ready && typeof msg.port === "number") {
        resolvePromise({ worker, port: msg.port });
      } else {
        reject(new Error(msg?.error ?? "worker 启动失败"));
      }
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function httpPost(port: number, path: string, token: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-loan-conc-"));
  dbFile = join(dir, "test.db");

  // 在单连接中完成种子数据（用户/账户/贷款/期次），随后关闭该连接，
  // 让两个并发 worker 各自以独立连接打开同一数据库文件。
  const created = createDb(dbFile);
  runMigrations(created.sqlite, resolve("./migrations"));
  const seedApp = await buildApp({ db: created.db, jwtSecret: JWT_SECRET });

  const u1 = await seedUser(seedApp, "conc-user1@test.com");
  token1 = u1.token;
  ledgerId1 = u1.ledgerId;
  bankId1 = u1.bankId;
  const loan1 = await createLoan(seedApp, token1, ledgerId1, bankId1, "并发贷款1");
  loanId1 = loan1.loanId;
  inst1Id = loan1.schedule[0]!.id;
  firstDue = loan1.schedule[0]!.dueDate;

  const u2 = await seedUser(seedApp, "conc-user2@test.com");
  token2 = u2.token;
  ledgerId2 = u2.ledgerId;
  bankId2 = u2.bankId;
  const loan2 = await createLoan(seedApp, token2, ledgerId2, bankId2, "隔离贷款2");
  loanId2 = loan2.loanId;
  inst2_1 = loan2.schedule[0]!.id;

  await seedApp.close();
  created.sqlite.close();

  const a = await spawnServer(dbFile);
  workerA = a.worker;
  portA = a.port;
  const b = await spawnServer(dbFile);
  workerB = b.worker;
  portB = b.port;
});

after(async () => {
  if (workerA) await workerA.terminate();
  if (workerB) await workerB.terminate();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("两个独立 App 实例 + 两个 SQLite 连接真正并发：同 key 同请求双响应成功且其一 replayed", async () => {
  const body = {
    payFromAccountId: bankId1,
    date: firstDue,
    ledgerId: ledgerId1,
    installmentId: inst1Id,
    idempotencyKey: "conc-key-1",
  };
  // 真正并发：对两个独立 App 实例（各自独立 SQLite 连接、独立线程）同时发起 HTTP
  const [r1, r2] = await Promise.all([
    httpPost(portA, `/api/v1/loans/${loanId1}/pay`, token1, body),
    httpPost(portB, `/api/v1/loans/${loanId1}/pay`, token1, body),
  ]);

  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));

  const a = r1.body as { replayed?: boolean; paymentGroupId?: string };
  const b = r2.body as { replayed?: boolean; paymentGroupId?: string };
  // 同一 key 同请求：必有一个首次成功（replayed=false），另一个重放（replayed=true）
  assert.equal(a.replayed === true || b.replayed === true, true, "应存在一个 replayed=true");
  assert.equal(a.replayed === false || b.replayed === false, true, "应存在一个 replayed=false");
  assert.equal(a.replayed, !b.replayed, "两个响应应恰好一个 replayed");
  // paymentGroupId 必须完全相同：仅一期、仅一个分组、仅两条流水
  assert.ok(a.paymentGroupId && a.paymentGroupId === b.paymentGroupId, "paymentGroupId 应完全相同");
  assert.equal(a.installmentId, inst1Id, "重放应指向同一期");
  assert.equal(b.installmentId, inst1Id, "重放应指向同一期");

  // 数据层验证：仅一期 paid、仅一个分组、仅两条流水、仅一条幂等记录
  const v = createDb(dbFile);
  try {
    const schedule = v.db
      .select()
      .from(loanPayments)
      .where(eq(loanPayments.loanId, loanId1))
      .orderBy(asc(loanPayments.installmentNo))
      .all();
    assert.equal(schedule.filter((p) => p.paid).length, 1, "应该只有一期已还");
    const groupTx = v.db
      .select()
      .from(transactions)
      .where(eq(transactions.paymentGroupId, a.paymentGroupId!))
      .all();
    assert.equal(groupTx.length, 2, "一个还款分组应恰好 2 条流水");
    const idems = v.db
      .select()
      .from(loanPaymentIdempotency)
      .where(
        and(
          eq(loanPaymentIdempotency.loanId, loanId1),
          eq(loanPaymentIdempotency.idempotencyKey, "conc-key-1"),
        ),
      )
      .all();
    assert.equal(idems.length, 1, "并发同 key 应只落一条幂等记录");
  } finally {
    v.sqlite.close();
  }
});

// 顺序重放已还期次（同 key 同请求体，期次已 paid）：必须返回 replayed=true，
// 绝不能返回 INSTALLMENT_ALREADY_PAID —— 这正是“并发冲突后重新读取已完成结果”的顺序等价形式。
test("同 key 重放已还期次：返回 replayed=true 而非 INSTALLMENT_ALREADY_PAID", async () => {
  const res = await httpPost(portA, `/api/v1/loans/${loanId1}/pay`, token1, {
    payFromAccountId: bankId1,
    date: firstDue,
    ledgerId: ledgerId1,
    installmentId: inst1Id,
    idempotencyKey: "conc-key-1",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((res.body as { replayed?: boolean }).replayed, true, "已还期次同 key 重放应 replayed=true");
});

test("跨用户 key 隔离：不同用户可用相同 idempotencyKey 各自独立还款", async () => {
  const v2 = createDb(dbFile);
  let due2 = "";
  try {
    const rows = v2.db.select().from(loanPayments).where(eq(loanPayments.loanId, loanId2)).orderBy(asc(loanPayments.installmentNo)).all();
    due2 = rows[0]!.dueDate;
  } finally {
    v2.sqlite.close();
  }
  const res = await httpPost(portA, `/api/v1/loans/${loanId2}/pay`, token2, {
    payFromAccountId: bankId2,
    date: due2,
    ledgerId: ledgerId2,
    installmentId: inst2_1,
    idempotencyKey: "conc-key-1", // 与 user1 完全相同，但 actor 不同 → 互不影响
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as { replayed?: boolean; paymentGroupId?: string };
  assert.equal(body.replayed, false, "跨用户复用相同 key 不应命中重放");
  assert.ok(body.paymentGroupId, "应有独立的 paymentGroupId");
});

test("同一 key 复用但请求体不同（不同期次）→ 409 IDEMPOTENCY_KEY_REUSED", async () => {
  // user1 的贷款1 第 1 期已被并发测试用 conc-key-1 还掉；再用同 key 还第 2 期 → 指纹不同
  const schedule = (() => {
    const v = createDb(dbFile);
    try {
      return v.db.select().from(loanPayments).where(eq(loanPayments.loanId, loanId1)).orderBy(asc(loanPayments.installmentNo)).all();
    } finally {
      v.sqlite.close();
    }
  })();
  const second = schedule.find((p) => !p.paid)!;
  const res = await httpPost(portA, `/api/v1/loans/${loanId1}/pay`, token1, {
    payFromAccountId: bankId1,
    date: second.dueDate,
    ledgerId: ledgerId1,
    installmentId: second.id,
    idempotencyKey: "conc-key-1",
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /IDEMPOTENCY_KEY_REUSED/);
});

test("偿还下一期必须提供 idempotencyKey（无 key 返回 400）", async () => {
  // loan1 还有第 2、3、4 期未还：不带 installmentId 且不带 key → 400
  const res = await httpPost(portA, `/api/v1/loans/${loanId1}/pay`, token1, {
    payFromAccountId: bankId1,
    date: firstDue,
    ledgerId: ledgerId1,
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /IDEMPOTENCY_KEY_REQUIRED/);
});
