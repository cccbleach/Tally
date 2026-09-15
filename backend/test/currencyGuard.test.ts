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
import { smsRegister } from "./helpers.js";

// 跨币种护栏回归（Phase 1）：
// 历史缺陷是"只在创建流水时校验币种"，其它写路径都能绕过：
//   1) PATCH /transactions/:id 改 accountId  → CNNY 流水可挂到 USD 账户（返回 200）
//   2) PATCH /accounts/:id 直接改 currency    → 历史金额被重新解释成另一种币种
//   3) 旧导入 /transactions/import            → 完全不校验账户币种
//   4) /imports/jobs 暂存与 commit            → 同样不校验
//   5) 币种字段本身无格式校验（可写入 "hello"）
let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;
let H: Record<string, string>;

function req(method: string, url: string, body?: unknown) {
  const h = { ...H };
  if (body !== undefined) h["content-type"] = "application/json";
  return app.inject({ method, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
}

let cnyAccountId = "";
let usdAccountId = "";
let expenseCategoryId = "";
let txId = "";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-currency-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "currency-guard-secret-0123456789" });

  const reg = await smsRegister(app, "13811110001", "币种回归用户");
  H = { authorization: "Bearer " + reg.token };

  const cny = await req("POST", "/api/v1/accounts", { name: "人民币卡", type: "bank", currency: "CNY", initialBalance: 0 });
  cnyAccountId = cny.json().item.id;
  const usd = await req("POST", "/api/v1/accounts", { name: "美元卡", type: "bank", currency: "USD", initialBalance: 0 });
  usdAccountId = usd.json().item.id;

  const cats = (await req("GET", "/api/v1/categories")).json().items as Array<{ id: string; type: string }>;
  expenseCategoryId = cats.find((c) => c.type === "expense")!.id;

  const tx = await req("POST", "/api/v1/transactions", {
    type: "expense", amount: 10000, date: "2025-01-15", accountId: cnyAccountId, currency: "CNY", categoryId: expenseCategoryId,
  });
  assert.equal(tx.statusCode, 200, tx.body);
  txId = tx.json().item.id;
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("对照组：创建时跨币种流水被拒绝（CURRENCY_MISMATCH）", async () => {
  const res = await req("POST", "/api/v1/transactions", {
    type: "expense", amount: 10000, date: "2025-01-15", accountId: cnyAccountId, currency: "USD", categoryId: expenseCategoryId,
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error.code, "CURRENCY_MISMATCH");
});

test("PATCH 流水改到外币账户必须被拒绝（历史缺陷：返回 200 且币种不自洽）", async () => {
  const res = await req("PATCH", `/api/v1/transactions/${txId}`, { accountId: usdAccountId });
  assert.equal(res.statusCode, 400, "跨币种改账户必须 400，而不是 200: " + res.body);
  assert.equal(res.json().error.code, "CURRENCY_MISMATCH");

  // 仍然挂在原账户上，且币种未被改动
  const after = await req("GET", `/api/v1/transactions/${txId}`);
  assert.equal(after.json().item.accountId, cnyAccountId, "拒绝后不应产生任何写入");
  assert.equal(after.json().item.currency, "CNY");
});

test("同币种 PATCH 改账户仍然允许（护栏不能误伤正常操作）", async () => {
  const cny2 = await req("POST", "/api/v1/accounts", { name: "人民币卡2", type: "cash", currency: "CNY", initialBalance: 0 });
  const res = await req("PATCH", `/api/v1/transactions/${txId}`, { accountId: cny2.json().item.id });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().item.accountId, cny2.json().item.id);
  // 改回去，避免影响后续用例
  const back = await req("PATCH", `/api/v1/transactions/${txId}`, { accountId: cnyAccountId });
  assert.equal(back.statusCode, 200, back.body);
});

test("账户已有流水后禁止改币种（ACCOUNT_CURRENCY_LOCKED）；无引用时可改", async () => {
  const locked = await req("PATCH", `/api/v1/accounts/${cnyAccountId}`, { currency: "USD" });
  assert.equal(locked.statusCode, 400, "已有流水的账户改币种必须 400: " + locked.body);
  assert.equal(locked.json().error.code, "ACCOUNT_CURRENCY_LOCKED");

  const untouched = await req("GET", `/api/v1/accounts/${cnyAccountId}`);
  assert.equal(untouched.json().item.currency, "CNY", "拒绝后币种必须保持原值");

  // 新建的空账户不引用任何业务数据 → 允许改币种
  const empty = await req("POST", "/api/v1/accounts", { name: "空账户", type: "cash", currency: "CNY", initialBalance: 0 });
  const ok = await req("PATCH", `/api/v1/accounts/${empty.json().item.id}`, { currency: "usd" });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().item.currency, "USD", "小写币种应被归一为大写");
});

test("币种字段格式校验：垃圾值被拒绝，小写被归一为大写", async () => {
  for (const bad of ["hello", "CN", "CNYY", "12", " ¥"]) {
    const res = await req("POST", "/api/v1/accounts", { name: "垃圾币", type: "other", currency: bad, initialBalance: 0 });
    assert.equal(res.statusCode, 400, `币种 ${JSON.stringify(bad)} 应被拒绝: ` + res.body);
  }
  const lower = await req("POST", "/api/v1/accounts", { name: "小写币种", type: "other", currency: "jpy", initialBalance: 0 });
  assert.equal(lower.statusCode, 200, lower.body);
  assert.equal(lower.json().item.currency, "JPY");
});

test("旧导入接口：items 模式跟随账户币种（不再硬编码 CNY）", async () => {
  // items 模式无法携带币种（zod 会剥离未知字段），因此应以目标账户币种落库。
  // 用一个"唯一账户是 USD"的新用户验证：此前会被静默记成 CNY。
  const reg = await smsRegister(app, "13811110009", "美元账本用户");
  const usdH = { authorization: "Bearer " + reg.token };
  const usdAcct = await app.inject({
    method: "POST", url: "/api/v1/accounts", headers: usdH,
    payload: { name: "美元主卡", type: "bank", currency: "USD", initialBalance: 0 },
  });
  assert.equal(usdAcct.statusCode, 200, usdAcct.body);

  const imported = await app.inject({
    method: "POST", url: "/api/v1/transactions/import", headers: { ...usdH, "content-type": "application/json" },
    payload: { mode: "items", items: [{ date: "2025-02-01", amount: 1234, type: "expense", note: "美元账本导入" }] },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json().imported, 1);

  const list = await app.inject({ method: "GET", url: "/api/v1/transactions", headers: usdH });
  const tx = (list.json().items as Array<{ note: string; currency: string }>).find((t) => t.note === "美元账本导入");
  assert.ok(tx, "导入的流水应可查到");
  assert.equal(tx!.currency, "USD", "items 模式应跟随账户币种，而不是硬编码 CNY");
});

function uploadBankCsv(csv: string, authorization: Record<string, string>) {
  const boundary = "CurrencyGuardBoundary";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bank.csv"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(csv),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST", url: "/api/v1/imports/jobs/upload",
    headers: { ...authorization, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

test("导入暂存：银行账单外币明细与账户币种不符时整批拒绝，且不留半成品 job", async () => {
  const reg = await smsRegister(app, "13811110010", "人民币账本用户");
  const h = { authorization: "Bearer " + reg.token };
  await app.inject({
    method: "POST", url: "/api/v1/accounts", headers: h,
    payload: { name: "人民币主卡", type: "bank", currency: "CNY", initialBalance: 0 },
  });

  // 对照：同一格式的 CNY 账单必须能正常暂存（护栏不能误伤正常导入）
  const cnyOnly = "记账日期,币种,交易金额,联机余额,交易摘要,对手信息\n2025-03-01,CNY,-25.00,975.00,消费,本地商店\n";
  const ok = await uploadBankCsv(cnyOnly, h);
  assert.equal(ok.statusCode, 200, ok.body);

  const mixed = "记账日期,币种,交易金额,联机余额,交易摘要,对手信息\n2025-03-02,CNY,-10.00,990.00,消费,本地商店\n2025-03-03,USD,-30.00,960.00,消费,海外商店\n";
  const rejected = await uploadBankCsv(mixed, h);
  assert.equal(rejected.statusCode, 400, "含外币明细的账单必须整批拒绝: " + rejected.body);
  assert.equal(rejected.json().error.code, "CURRENCY_MISMATCH");

  const jobs = (await app.inject({ method: "GET", url: "/api/v1/imports/jobs", headers: h })).json().items as unknown[];
  assert.equal(jobs.length, 1, "被拒绝的上传不得留下半成品 job（只应有前面 CNY 那一个）");
});

test("导入暂存：明细改挂外币账户时提交仍被拒绝", async () => {
  const staged = await req("POST", "/api/v1/imports/jobs", {
    mode: "items",
    items: [{ date: "2025-03-02", amount: 700, type: "expense", note: "CNY 明细" }],
  });
  assert.equal(staged.statusCode, 200, staged.body);
  const jobId = staged.json().item.id as string;

  const detail = await req("GET", `/api/v1/imports/jobs/${jobId}`);
  const itemId = (detail.json().items as Array<{ id: string }>)[0]!.id;

  // 把明细改挂到 USD 账户 → 必须立刻拒绝
  const patched = await req("PATCH", `/api/v1/imports/items/${itemId}`, { accountId: usdAccountId });
  assert.equal(patched.statusCode, 400, "改挂外币账户必须被拒绝: " + patched.body);
  assert.equal(patched.json().error.code, "CURRENCY_MISMATCH");
});

test("贷款创建：还款来源账户币种与贷款币种不一致时提前拒绝", async () => {
  const res = await req("POST", "/api/v1/loans", {
    name: "美元车贷", type: "car", currency: "USD", principal: 100000, annualRate: 3, termMonths: 12,
    startDate: "2025-01-01", accountId: cnyAccountId,
  });
  assert.equal(res.statusCode, 400, "USD 贷款绑定 CNY 还款账户必须 400（而不是等到还款才报错）: " + res.body);
  assert.equal(res.json().error.code, "CURRENCY_MISMATCH");
});

test("贷款 PATCH：改还款来源账户/负债账户时的币种护栏（修复已复现的绕过）", async () => {
  // 历史缺陷（已复现）：创建期校验了币种，但 PATCH /loans/:id 改账户时完全不校验，
  // 于是可以把 CNY 贷款改绑到 USD 账户；此后 /loans/:id/pay 必然 CURRENCY_MISMATCH，
  // 用户就卡在一笔无法偿还的贷款上。
  const created = await req("POST", "/api/v1/loans", {
    name: "人民币车贷", type: "car", currency: "CNY", principal: 100000, annualRate: 3,
    termMonths: 12, startDate: "2025-01-01", accountId: cnyAccountId,
  });
  assert.equal(created.statusCode, 200, created.body);
  const loanId = created.json().item.id as string;

  // 1) 改成外币还款账户 → 必须 400，且不得写入
  const bad = await req("PATCH", `/api/v1/loans/${loanId}`, { accountId: usdAccountId });
  assert.equal(bad.statusCode, 400, "跨币种改还款来源账户必须 400: " + bad.body);
  assert.equal(bad.json().error.code, "CURRENCY_MISMATCH");
  const afterBad = await req("GET", `/api/v1/loans/${loanId}`);
  assert.equal(afterBad.json().item.accountId, cnyAccountId, "被拒绝后不得产生写入");

  // 2) 同币种的账户改动仍然允许（护栏不能误伤正常操作）
  const cny2 = await req("POST", "/api/v1/accounts", { name: "人民币卡2", type: "bank", currency: "CNY", initialBalance: 0 });
  const ok = await req("PATCH", `/api/v1/loans/${loanId}`, { accountId: cny2.json().item.id });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().item.accountId, cny2.json().item.id);

  // 3) 负债账户（代表贷款本身）改成外币也是 400
  const foreignLiability = await req("POST", "/api/v1/accounts", {
    name: "美元负债账户", type: "loan", currency: "USD", initialBalance: 0,
  });
  assert.equal(foreignLiability.statusCode, 200, foreignLiability.body);
  const badLiab = await req("PATCH", `/api/v1/loans/${loanId}`, { liabilityAccountId: foreignLiability.json().item.id });
  assert.equal(badLiab.statusCode, 400, "外币负债账户必须被拒绝: " + badLiab.body);
  assert.equal(badLiab.json().error.code, "CURRENCY_MISMATCH");

  // 4) 护栏生效后，这笔贷款必须仍然可以正常还款（不留下"无法偿还"的状态）
  const pay = await req("POST", `/api/v1/loans/${loanId}/pay`, { idempotencyKey: "currency-guard-pay-1" });
  assert.equal(pay.statusCode, 200, "同币种绑定下必须能正常还款: " + pay.body);
});
