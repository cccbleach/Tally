import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { runDueRecurring } from "../src/lib/recurringRunner.js";
import { todayStr, addMonths } from "../src/lib/date.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { transactions, recurring, ledgers, accounts, users } from "../src/db/schema.js";
import { setRate } from "../src/lib/currency.js";

// 测试保持确定：强制走短信“开发模式”（本地生成/校验验证码），不依赖真实短信网络
process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";

let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;
let headers: Record<string, string> = {};

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
  dir = mkdtempSync(join(tmpdir(), "tally-test-"));
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

test("health", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "ok");
});

test("register 后自动播种默认分类", async () => {
  const res = await req("POST", "/api/v1/auth/register", {
    email: "test@example.com",
    password: "password123",
    displayName: "测试用户",
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.token);
  assert.equal(body.user.email, "test@example.com");
  headers = { authorization: "Bearer " + body.token };

  const cats = await req("GET", "/api/v1/categories");
  assert.equal(cats.statusCode, 200);
  assert.ok(cats.json().items.length >= 12, "默认分类应已播种");
});

test("重复注册返回 409", async () => {
  const res = await req("POST", "/api/v1/auth/register", {
    email: "test@example.com",
    password: "password123",
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "EMAIL_EXISTS");
});

test("登录成功与失败", async () => {
  const ok = await req("POST", "/api/v1/auth/login", {
    email: "test@example.com",
    password: "password123",
  });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json().token);

  const bad = await req("POST", "/api/v1/auth/login", {
    email: "test@example.com",
    password: "wrong-password",
  });
  assert.equal(bad.statusCode, 401);
});

test("未带 token 访问受保护接口返回 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/accounts" });
  assert.equal(res.statusCode, 401);
});

test("me 返回当前用户", async () => {
  const res = await req("GET", "/api/v1/auth/me");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user.email, "test@example.com");
});

// ---- 账户 ----
let accountA = "";
let accountB = "";

test("创建账户", async () => {
  const a = await req("POST", "/api/v1/accounts", {
    name: "银行卡",
    type: "bank",
    initialBalance: 0,
  });
  assert.equal(a.statusCode, 200);
  accountA = a.json().item.id;

  const b = await req("POST", "/api/v1/accounts", {
    name: "现金",
    type: "cash",
    initialBalance: 5000,
  });
  assert.equal(b.statusCode, 200);
  accountB = b.json().item.id;

  const list = await req("GET", "/api/v1/accounts");
  assert.equal(list.json().items.length, 2);
});

// ---- 分类 ----
let expCat = "";
let incCat = "";

test("获取分类并取支出/收入分类", async () => {
  const cats = await req("GET", "/api/v1/categories");
  const items = cats.json().items as Array<{ id: string; type: string; name: string }>;
  expCat = items.find((c) => c.type === "expense")!.id;
  incCat = items.find((c) => c.type === "income")!.id;
  assert.ok(expCat && incCat);
});

test("自定义分类增删改", async () => {
  const created = await req("POST", "/api/v1/categories", {
    name: "旅行",
    type: "expense",
    icon: "airplane",
    color: "#FF0000",
  });
  assert.equal(created.statusCode, 200);
  const id = created.json().item.id;

  const patched = await req("PATCH", "/api/v1/categories/" + id, { name: "旅游" });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().item.name, "旅游");

  const del = await req("DELETE", "/api/v1/categories/" + id);
  assert.equal(del.statusCode, 200);
});

// ---- 流水 ----
test("记支出与收入", async () => {
  const exp = await req("POST", "/api/v1/transactions", {
    type: "expense",
    amount: 3000,
    accountId: accountA,
    categoryId: expCat,
    date: todayStr(),
    note: "午餐",
  });
  assert.equal(exp.statusCode, 200, exp.body);

  const inc = await req("POST", "/api/v1/transactions", {
    type: "income",
    amount: 10000,
    accountId: accountA,
    categoryId: incCat,
    date: todayStr(),
  });
  assert.equal(inc.statusCode, 200, inc.body);
});

test("分类类型不匹配返回 400", async () => {
  const res = await req("POST", "/api/v1/transactions", {
    type: "expense",
    amount: 100,
    accountId: accountA,
    categoryId: incCat,
    date: todayStr(),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "CATEGORY_TYPE_MISMATCH");
});

test("转账", async () => {
  const res = await req("POST", "/api/v1/transactions", {
    type: "transfer",
    amount: 2000,
    accountId: accountA,
    transferToAccountId: accountB,
    date: todayStr(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().item.type, "transfer");
});

test("账户余额计算正确", async () => {
  // A: 收入10000 - 支出3000 - 转出2000 = 5000；B: 初始5000 + 转入2000 = 7000
  const list = await req("GET", "/api/v1/accounts");
  const items = list.json().items as Array<{ id: string; balance: number }>;
  const a = items.find((x) => x.id === accountA)!;
  const b = items.find((x) => x.id === accountB)!;
  assert.equal(a.balance, 5000);
  assert.equal(b.balance, 7000);
});

test("流水分页与过滤", async () => {
  const all = await req("GET", "/api/v1/transactions?limit=10");
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().total, 3);

  const expOnly = await req("GET", "/api/v1/transactions?type=expense");
  assert.equal(expOnly.json().total, 1);

  const transferOnly = await req("GET", "/api/v1/transactions?type=transfer");
  assert.equal(transferOnly.json().total, 1);
  assert.equal(transferOnly.json().items[0].transferToAccountName, "现金");
});

test("按转入账户过滤可查到转账流水", async () => {
  const byAccountB = await req("GET", "/api/v1/transactions?accountId=" + accountB);
  assert.equal(byAccountB.statusCode, 200, byAccountB.body);
  const transfers = (byAccountB.json().items as Array<{ type: string; transferToAccountId: string | null }>).filter(
    (t) => t.type === "transfer" && t.transferToAccountId === accountB,
  );
  assert.equal(transfers.length, 1, "按转入账户应能查到该笔转账");
});

test("修改与删除流水", async () => {
  // 用一次性流水测试改/删，不影响后续统计断言
  const created = await req("POST", "/api/v1/transactions", {
    type: "expense",
    amount: 100,
    accountId: accountA,
    categoryId: expCat,
    date: todayStr(),
    note: "临时",
  });
  assert.equal(created.statusCode, 200);
  const id = created.json().item.id;

  const patched = await req("PATCH", "/api/v1/transactions/" + id, { amount: 150, note: "改过的" });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().item.amount, 150);

  const del = await req("DELETE", "/api/v1/transactions/" + id);
  assert.equal(del.statusCode, 200);
});

// ---- 统计 ----
test("统计摘要正确", async () => {
  const res = await req("GET", "/api/v1/stats/summary?year=" + new Date().getFullYear() + "&month=" + (new Date().getMonth() + 1));
  assert.equal(res.statusCode, 200);
  const s = res.json();
  assert.equal(s.income, 10000);
  assert.equal(s.expense, 3000);
  assert.equal(s.net, 7000);
  assert.equal(s.balance, 5000 + 7000);
  assert.ok(Array.isArray(s.byCategory));
  assert.ok(Array.isArray(s.daily));
});

test("趋势接口", async () => {
  const res = await req("GET", "/api/v1/stats/trend?months=6");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().months.length, 6);
});

// ---- 预算 ----
test("预算 upsert 与 overview", async () => {
  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;
  const total = await req("POST", "/api/v1/budgets", { year, month, amount: 20000 });
  assert.equal(total.statusCode, 200);
  const cat = await req("POST", "/api/v1/budgets", { year, month, categoryId: expCat, amount: 5000 });
  assert.equal(cat.statusCode, 200);

  // 再次 upsert 总预算
  const again = await req("POST", "/api/v1/budgets", { year, month, amount: 30000 });
  assert.equal(again.statusCode, 200);

  const overview = await req("GET", "/api/v1/budgets/overview?year=" + year + "&month=" + month);
  assert.equal(overview.statusCode, 200);
  const o = overview.json();
  assert.equal(o.totalBudget, 30000);
  assert.equal(o.totalSpent, 3000);
});

// ---- 周期账单 ----
test("周期账单自动生成且幂等", async () => {
  const before2 = await req("GET", "/api/v1/stats/summary");
  const expenseBefore = before2.json().expense;

  const created = await req("POST", "/api/v1/recurring", {
    type: "expense",
    amount: 1000,
    accountId: accountA,
    categoryId: expCat,
    frequency: "monthly",
    interval: 1,
    startDate: todayStr(),
    note: "会员订阅",
  });
  assert.equal(created.statusCode, 200, created.body);
  const rid = created.json().item.id;

  const n = runDueRecurring(db);
  assert.equal(n, 1, "应生成 1 笔流水");

  // 幂等：再跑一次不重复生成
  const n2 = runDueRecurring(db);
  assert.equal(n2, 0, "再次运行不应重复生成");

  const after2 = await req("GET", "/api/v1/stats/summary");
  assert.equal(after2.json().expense, expenseBefore + 1000);

  const del = await req("DELETE", "/api/v1/recurring/" + rid);
  assert.equal(del.statusCode, 200);
});

test("周期账单未来开始日期不生成", async () => {
  const future = addMonths(todayStr(), 1);
  const created = await req("POST", "/api/v1/recurring", {
    type: "income",
    amount: 500,
    accountId: accountA,
    categoryId: incCat,
    frequency: "monthly",
    interval: 1,
    startDate: future,
  });
  assert.equal(created.statusCode, 200);
  const n = runDueRecurring(db);
  assert.equal(n, 0);
});

// 契约回归：POST/PATCH 预算必须返回 spent/percent，iOS 客户端依赖这些字段解码。
test("预算创建与更新返回 spent/percent 字段", async () => {
  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;

  const created = await req("POST", "/api/v1/budgets", { year, month, amount: 9999 });
  assert.equal(created.statusCode, 200, created.body);
  const createdItem = created.json().item;
  assert.ok("spent" in createdItem, "POST /budgets 返回项应含 spent");
  assert.ok("percent" in createdItem, "POST /budgets 返回项应含 percent");

  const patched = await req("PATCH", "/api/v1/budgets/" + createdItem.id, { amount: 12345 });
  assert.equal(patched.statusCode, 200, patched.body);
  const patchedItem = patched.json().item;
  assert.ok("spent" in patchedItem, "PATCH /budgets/:id 返回项应含 spent");
  assert.ok("percent" in patchedItem, "PATCH /budgets/:id 返回项应含 percent");
  assert.equal(patchedItem.amount, 12345);

  const del = await req("DELETE", "/api/v1/budgets/" + createdItem.id);
  assert.equal(del.statusCode, 200);
});

// 真正数据层幂等：即使把 nextRunDate 重置回过去（模拟旧 bug / 崩溃恢复后的重跑），
// (recurring_id, date) 唯一约束也会让重复流水被跳过。
test("周期账单在数据层幂等（重置 nextRunDate 不重复入账）", async () => {
  const created = await req("POST", "/api/v1/recurring", {
    type: "expense",
    amount: 777,
    accountId: accountA,
    categoryId: expCat,
    frequency: "daily",
    interval: 1,
    startDate: todayStr(),
  });
  assert.equal(created.statusCode, 200, created.body);
  const rid = created.json().item.id;

  const n1 = runDueRecurring(db);
  assert.equal(n1, 1, "首次应生成 1 笔");
  const generated = db
    .select()
    .from(transactions)
    .where(eq(transactions.recurringId, rid))
    .all();
  assert.equal(generated.length, 1);
  assert.equal(generated[0]!.recurringId, rid, "生成的流水应带 recurring_id");

  // 手动把 nextRunDate 重置回过去，模拟崩溃/旧逻辑导致的重复补跑
  db.update(recurring)
    .set({ nextRunDate: todayStr() })
    .where(eq(recurring.id, rid))
    .run();
  const n2 = runDueRecurring(db);
  assert.equal(n2, 0, "唯一约束应阻止重复入账，返回 0 新增");
  const again = db
    .select()
    .from(transactions)
    .where(eq(transactions.recurringId, rid))
    .all();
  assert.equal(again.length, 1, "流水数量不应增加");

  const del = await req("DELETE", "/api/v1/recurring/" + rid);
  assert.equal(del.statusCode, 200);
});

test("多币种流水按汇率折算到基准币种（不直接相加）", async () => {
  const before = await req("GET", "/api/v1/stats/summary");
  assert.equal(before.statusCode, 200, before.body);
  const expenseBefore = before.json().expense;

  // 自定义币种 XYZ（不在内置表内），1 XYZ = 2.5 CNY
  setRate(db, null, "CNY", "XYZ", 2.5);

  const acc = await req("POST", "/api/v1/accounts", {
    name: "外币账户",
    type: "bank",
    currency: "XYZ",
    initialBalance: 0,
  });
  assert.equal(acc.statusCode, 200, acc.body);
  const accId = acc.json().item.id;

  const tx = await req("POST", "/api/v1/transactions", {
    type: "expense",
    amount: 100,
    accountId: accId,
    categoryId: expCat,
    currency: "XYZ",
    date: todayStr(),
  });
  assert.equal(tx.statusCode, 200, tx.body);

  const s = await req("GET", "/api/v1/stats/summary");
  assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json().expense, expenseBefore + 250, "外币支出应按汇率折算为基准币种");
});

test("信用卡负债方向与资产负债拆分正确", async () => {
  const card = await req("POST", "/api/v1/accounts", {
    name: "信用卡",
    type: "credit",
    currency: "CNY",
    initialBalance: 0,
  });
  assert.equal(card.statusCode, 200, card.body);
  const cardId = card.json().item.id;
  assert.equal(card.json().item.isLiability, true, "信用卡应标记为负债账户");

  // 刷卡消费 3000，欠款应为 +3000（负债方向），净值口径余额为 -3000
  const tx = await req("POST", "/api/v1/transactions", {
    type: "expense",
    amount: 3000,
    accountId: cardId,
    categoryId: expCat,
    currency: "CNY",
    date: todayStr(),
  });
  assert.equal(tx.statusCode, 200, tx.body);

  const list = await req("GET", "/api/v1/accounts");
  const c = (list.json().items as Array<{ id: string; balance: number; debt: number; isLiability: boolean }>).find(
    (a) => a.id === cardId,
  )!;
  assert.equal(c.isLiability, true);
  assert.equal(c.balance, -3000, "净值口径余额为负");
  assert.equal(c.debt, 3000, "欠款方向应为正数");

  const s = await req("GET", "/api/v1/stats/summary");
  assert.equal(s.statusCode, 200, s.body);
  assert.ok(s.json().totalDebt >= 3000, "统计应披露负债");
  assert.ok(s.json().totalAssets >= 0, "统计应披露资产");
});

test("账本隔离：非默认账本的数据不出现在默认 API 中", async () => {
  const u = db.select().from(users).where(eq(users.email, "test@example.com")).get()!;
  const otherLedgerId = randomUUID();
  const now = new Date().toISOString();
  db.insert(ledgers)
    .values({ id: otherLedgerId, userId: u.id, name: "第二个账本", isDefault: false, createdAt: now, updatedAt: now })
    .run();
  const otherAccountId = randomUUID();
  db.insert(accounts)
    .values({
      id: otherAccountId,
      userId: u.id,
      ledgerId: otherLedgerId,
      name: "另一个账本的账户",
      type: "bank",
      currency: "CNY",
      initialBalance: 8888,
      createdAt: now,
    })
    .run();

  const list = await req("GET", "/api/v1/accounts");
  assert.equal(list.statusCode, 200, list.body);
  const ids = (list.json().items as Array<{ id: string }>).map((a) => a.id);
  assert.ok(!ids.includes(otherAccountId), "默认账本接口不应返回其他账本的账户");
});

test("乐观锁：预期更新时间戳不匹配返回 409", async () => {
  const created = await req("POST", "/api/v1/transactions", {
    type: "expense",
    amount: 50,
    accountId: accountA,
    categoryId: expCat,
    date: todayStr(),
  });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().item.id;
  const upd = created.json().item.updatedAt as string;

  const stale = await req("PATCH", "/api/v1/transactions/" + id, {
    amount: 60,
    expectedUpdatedAt: "1990-01-01T00:00:00.000Z",
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error.code, "CONFLICT");

  const ok = await req("PATCH", "/api/v1/transactions/" + id, { amount: 60, expectedUpdatedAt: upd });
  assert.equal(ok.statusCode, 200, ok.body);

  const del = await req("DELETE", "/api/v1/transactions/" + id);
  assert.equal(del.statusCode, 200);
});

test("刷新令牌可换取新访问令牌", async () => {
  const login = await req("POST", "/api/v1/auth/login", {
    email: "test@example.com",
    password: "password123",
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.ok(login.json().refreshToken, "登录应返回 refreshToken");

  const refresh = await req("POST", "/api/v1/auth/refresh", {
    refreshToken: login.json().refreshToken,
  });
  assert.equal(refresh.statusCode, 200, refresh.body);
  assert.ok(refresh.json().token);
  assert.ok(refresh.json().refreshToken);

  // 用新访问令牌访问受保护接口
  const r2 = await req("GET", "/api/v1/accounts");
  const withNew = await app.inject({ method: "GET", url: "/api/v1/accounts", headers: { authorization: "Bearer " + refresh.json().token } });
  assert.equal(withNew.statusCode, 200);
  assert.equal(r2.statusCode, 200);
});

test("刷新令牌不能当作访问令牌使用", async () => {
  const login = await req("POST", "/api/v1/auth/login", {
    email: "test@example.com",
    password: "password123",
  });
  const bad = await app.inject({
    method: "GET",
    url: "/api/v1/accounts",
    headers: { authorization: "Bearer " + login.json().refreshToken },
  });
  assert.equal(bad.statusCode, 401);
});

test("忘记密码与重置密码流程", async () => {
  const forgot = await req("POST", "/api/v1/auth/forgot-password", { email: "test@example.com" });
  assert.equal(forgot.statusCode, 200, forgot.body);
  const resetToken = forgot.json().resetToken as string;
  assert.ok(resetToken, "应返回 resetToken");

  const reset = await req("POST", "/api/v1/auth/reset-password", { resetToken, newPassword: "newpass123" });
  assert.equal(reset.statusCode, 200, reset.body);

  const old = await req("POST", "/api/v1/auth/login", { email: "test@example.com", password: "password123" });
  assert.equal(old.statusCode, 401, "旧密码应失效");
  const fresh = await req("POST", "/api/v1/auth/login", { email: "test@example.com", password: "newpass123" });
  assert.equal(fresh.statusCode, 200, "新密码应可登录");
  headers = { authorization: "Bearer " + fresh.json().token };
});

test("健康检查校验数据库可达", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "ok");
});

test("支持手机号注册与登录", async () => {
  const register = await req("POST", "/api/v1/auth/register", {
    email: "13800138000",
    password: "phone12345",
  });
  assert.equal(register.statusCode, 200, register.body);
  assert.ok(register.json().token);

  // 手机号登录（带空格也应归一化成功）
  const login = await req("POST", "/api/v1/auth/login", {
    email: "138 0013 8000",
    password: "phone12345",
  });
  assert.equal(login.statusCode, 200, login.body);
});

test("手机号验证码登录（自动注册 + 校验码校验）", async () => {
  const codeReq = await req("POST", "/api/v1/auth/request-code", { email: "13700002222" });
  assert.equal(codeReq.statusCode, 200, codeReq.body);
  const code = codeReq.json().code as string;
  assert.match(code, /^\d{6}$/, "应返回 6 位验证码");

  // 错误验证码 → 400
  const wrong = await req("POST", "/api/v1/auth/login-code", { email: "13700002222", code: "000000" });
  assert.equal(wrong.statusCode, 400);

  // 正确验证码 → 登录成功且自动注册
  const ok = await req("POST", "/api/v1/auth/login-code", { email: "13700002222", code });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().token);
  assert.equal(ok.json().user.email, "13700002222");
});

test("账单导入按 external_id 去重（重复导入不重复入账）", async () => {
  const payload = {
    mode: "items",
    items: [
      { date: todayStr(), amount: 1500, type: "expense", note: "导入测试", externalId: "ext-001" },
      { date: todayStr(), amount: 2000, type: "income", note: "导入测试", externalId: "ext-002" },
    ],
  };
  const first = await req("POST", "/api/v1/transactions/import", payload);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().imported, 2);
  assert.equal(first.json().skipped, 0);

  // 重复导入：全部跳过
  const second = await req("POST", "/api/v1/transactions/import", payload);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().imported, 0);
  assert.equal(second.json().skipped, 2);

  // 确实只有 2 条
  const tx = await req("GET", "/api/v1/transactions?from=" + todayStr() + "&to=" + todayStr());
  assert.equal(tx.statusCode, 200, tx.body);
  const withExternal = (tx.json().items as Array<{ note: string | null }>).filter((t) => t.note === "导入测试");
  assert.equal(withExternal.length, 2);
});

test("家庭共享账本：成员可读共享数据，非成员不可访问个人账本", async () => {
  const regA = await req("POST", "/api/v1/auth/register", { email: "family-a@test.com", password: "password123" });
  assert.equal(regA.statusCode, 200, regA.body);
  const hA = { authorization: "Bearer " + regA.json().token };
  const idA = regA.json().user.id as string;

  const regB = await req("POST", "/api/v1/auth/register", { email: "family-b@test.com", password: "password123" });
  assert.equal(regB.statusCode, 200, regB.body);
  const hB = { authorization: "Bearer " + regB.json().token };
  const idB = regB.json().user.id as string;

  // A 创建家庭（自动创建家庭共享账本并切换为当前）
  const fam = await app.inject({ method: "POST", url: "/api/v1/families", headers: hA, payload: { name: "测试家庭" } });
  assert.equal(fam.statusCode, 200, fam.body);
  const familyId = fam.json().item.id as string;
  const familyLedger = fam.json().item.ledgerId as string;

  // A 在家庭账本建账户
  const acc = await app.inject({
    method: "POST",
    url: "/api/v1/accounts",
    headers: hA,
    payload: { name: "家庭账户", type: "bank", initialBalance: 0, ledgerId: familyLedger },
  });
  assert.equal(acc.statusCode, 200, acc.body);

  // B 加入家庭
  const add = await app.inject({
    method: "POST",
    url: `/api/v1/families/${familyId}/members`,
    headers: hA,
    payload: { userId: idB },
  });
  assert.equal(add.statusCode, 200, add.body);

  // B 能看到家庭账本里的账户
  const listB = await app.inject({ method: "GET", url: "/api/v1/accounts?ledgerId=" + familyLedger, headers: hB });
  assert.equal(listB.statusCode, 200, listB.body);
  assert.equal(listB.json().items.length, 1, "家庭成员应能看到共享账本账户");

  // A 的个人默认账本
  const ledgersA = await app.inject({ method: "GET", url: "/api/v1/ledgers", headers: hA });
  const personalA = (ledgersA.json().items as Array<{ id: string; familyId: string | null }>).find((l) => l.familyId === null)!;
  const forbiddenB = await app.inject({ method: "GET", url: "/api/v1/accounts?ledgerId=" + personalA.id, headers: hB });
  assert.equal(forbiddenB.statusCode, 403, "非成员访问个人账本应 403");
});

test("跨来源去重：同一笔在不同来源（不同 externalId）导入只入账一次", async () => {
  const first = await req("POST", "/api/v1/transactions/import", {
    mode: "items",
    items: [{ date: todayStr(), amount: 6666, type: "expense", note: "美团外卖", externalId: "wechat-001" }],
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().imported, 1);

  // 来自银行/支付宝的同一天同金额同商家（写法略不同）应被判定为疑似重复并跳过
  const second = await req("POST", "/api/v1/transactions/import", {
    mode: "items",
    items: [{ date: todayStr(), amount: 6666, type: "expense", note: "美团外卖（特约）", externalId: "bank-001" }],
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().imported, 0, "跨来源重复应被跳过");
  assert.equal(second.json().skipped, 1);
  assert.ok(second.json().suspectedDuplicates.length >= 1, "应返回疑似重复信息");
});

test("贷款创建、还款与负债统计", async () => {
  const created = await req("POST", "/api/v1/loans", {
    name: "房贷",
    type: "mortgage",
    principal: 1_000_000, // 1万元
    annualRate: 4.9,
    termMonths: 12,
    startDate: "2026-01-01",
  });
  assert.equal(created.statusCode, 200, created.body);
  const loanId = created.json().item.id as string;
  assert.ok(created.json().item.monthlyPayment > 0);

  const detail = await req("GET", "/api/v1/loans/" + loanId);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().schedule.length, 12);

  const pay = await req("POST", "/api/v1/loans/" + loanId + "/pay", {});
  assert.equal(pay.statusCode, 200, pay.body);

  const liabilities = await req("GET", "/api/v1/liabilities");
  assert.equal(liabilities.statusCode, 200, liabilities.body);
  const loan = (liabilities.json().loans as Array<{ id: string; remainingPrincipal: number }>).find((l) => l.id === loanId);
  assert.ok(loan, "负债列表应包含贷款");
  assert.ok(loan.remainingPrincipal < 1_000_000, "还款后剩余本金应减少");
});

test("导入 force=true 可强制保留重复项", async () => {
  const item = { date: todayStr(), amount: 321, type: "expense", note: "重复保留测试", externalId: "force-001" };
  const first = await req("POST", "/api/v1/transactions/import", { mode: "items", items: [item] });
  assert.equal(first.json().imported, 1);

  const dup = await req("POST", "/api/v1/transactions/import", {
    mode: "items",
    items: [{ ...item, externalId: "force-002", note: "重复保留测试（特约）" }],
    force: true,
  });
  assert.equal(dup.statusCode, 200, dup.body);
  assert.equal(dup.json().imported, 1, "force=true 应强制新增");
});

test("信用卡账单创建、列表与标记已还", async () => {
  const acc = await req("POST", "/api/v1/accounts", {
    name: "信用卡账单测试",
    type: "credit",
    currency: "CNY",
    initialBalance: 0,
  });
  assert.equal(acc.statusCode, 200, acc.body);
  const accountId = acc.json().item.id as string;

  const create = await req("POST", `/api/v1/credit-cards/${accountId}/bills`, {
    period: "2026-08",
    statementBalance: 10000,
    minimumPayment: 1000,
    dueDate: "2026-08-25",
  });
  assert.equal(create.statusCode, 200, create.body);

  const bills = await req("GET", "/api/v1/credit-card-bills");
  assert.equal(bills.statusCode, 200, bills.body);
  const bill = (bills.json().items as Array<{ id: string; accountId: string }>).find((b) => b.accountId === accountId);
  assert.ok(bill, "应能查到新账单");

  const mark = await req("PATCH", `/api/v1/credit-card-bills/${bill!.id}`, { paid: true });
  assert.equal(mark.statusCode, 200, mark.body);
});

test("越权防护：B 看不到 A 账本的信用卡账单", async () => {
  const regA = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ email: "cc-a@test.com", password: "password123" }),
  });
  assert.equal(regA.statusCode, 200, regA.body);
  const hA = { authorization: "Bearer " + regA.json().token };

  const regB = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ email: "cc-b@test.com", password: "password123" }),
  });
  assert.equal(regB.statusCode, 200, regB.body);
  const hB = { authorization: "Bearer " + regB.json().token };

  const acc = await app.inject({
    method: "POST",
    url: "/api/v1/accounts",
    headers: hA,
    payload: { name: "A的信用卡", type: "credit", currency: "CNY", initialBalance: 0 },
  });
  assert.equal(acc.statusCode, 200, acc.body);
  const accountId = acc.json().item.id as string;

  const bill = await app.inject({
    method: "POST",
    url: `/api/v1/credit-cards/${accountId}/bills`,
    headers: hA,
    payload: { period: "2026-09", statementBalance: 88800, minimumPayment: 8880, dueDate: "2026-09-25" },
  });
  assert.equal(bill.statusCode, 200, bill.body);

  const liabB = await app.inject({ method: "GET", url: "/api/v1/liabilities", headers: hB });
  assert.equal(liabB.statusCode, 200, liabB.body);
  const billsFromLiab = liabB.json().creditCardBills ?? [];
  assert.equal(billsFromLiab.length, 0, "B 的负债中心不应出现任何他人的信用卡账单");

  const listB = await app.inject({ method: "GET", url: "/api/v1/credit-card-bills", headers: hB });
  assert.equal(listB.statusCode, 200, listB.body);
  const itemsB = listB.json().items ?? [];
  assert.equal(itemsB.length, 0, "B 的账单列表不应包含 A 的账单");
  assert.ok(!itemsB.some((x) => x.accountId === accountId), "B 不应看到 A 的账户账单");
});

test("健康检查：live 只探活，ready 校验数据库与迁移", async () => {
  const live = await app.inject({ method: "GET", url: "/health/live" });
  assert.equal(live.statusCode, 200, live.body);
  assert.equal(live.json().status, "ok");

  const ready = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(ready.statusCode, 200, ready.body);
  assert.ok(ready.json().migrationsApplied >= 1, "应报告已应用的迁移数量");
});

