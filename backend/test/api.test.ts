import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { runDueRecurring } from "../src/lib/recurringRunner.js";
import { todayStr, addMonths, currentYearMonth } from "../src/lib/date.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { transactions, recurring, ledgers, accounts, users } from "../src/db/schema.js";
import { setRate } from "../src/lib/currency.js";
import { smsRegister, smsLogin } from "./helpers.js";
import YAML from "yaml";

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
  assert.ok(res.headers["x-request-id"], "响应应带 x-request-id");
});

test("短信注册后自动播种默认分类", async () => {
  const body = await smsRegister(app, "13800000001", "测试用户");
  assert.equal(body.status, "authenticated");
  assert.ok(body.token);
  assert.equal(body.user.phone, "+8613800000001");
  assert.equal(body.user.nickname, "测试用户");
  headers = { authorization: "Bearer " + body.token };

  const cats = await req("GET", "/api/v1/categories");
  assert.equal(cats.statusCode, 200);
  assert.ok(cats.json().items.length >= 12, "默认分类应已播种");
});

test("验证码登录（已有账号直接登录 + 手机号归一化）", async () => {
  const first = await smsLogin(app, "13800000001");
  assert.equal(first.status, "authenticated");
  assert.ok(first.token);
  assert.equal(first.user.phone, "+8613800000001");

  // 手机号归一化：带空格/+86 也视为同一账号
  const normalized = await smsLogin(app, "+86 1380 0000 001");
  assert.equal(normalized.status, "authenticated");
  assert.equal(normalized.user.id, first.user.id);

  // 错误验证码 → 400
  const bad = await req("POST", "/api/v1/auth/login-code", { phone: "13800000001", code: "000000" });
  assert.equal(bad.statusCode, 400);
});

test("onboarding ticket 仅可使用一次 / 过期作废", async () => {
  const codeRes = await req("POST", "/api/v1/auth/request-code", { phone: "13700002222" });
  assert.equal(codeRes.statusCode, 200, codeRes.body);
  const code = codeRes.json().code as string;
  assert.match(code, /^\d{6}$/, "应返回 6 位验证码");

  const wrong = await req("POST", "/api/v1/auth/login-code", { phone: "13700002222", code: "000000" });
  assert.equal(wrong.statusCode, 400);

  const need = await req("POST", "/api/v1/auth/login-code", { phone: "13700002222", code });
  assert.equal(need.statusCode, 200, need.body);
  assert.equal(need.json().status, "nickname_required");
  const ticket = need.json().onboardingToken as string;
  assert.ok(ticket);

  const complete = await req("POST", "/api/v1/auth/complete-profile", { onboardingToken: ticket, nickname: "小七" });
  assert.equal(complete.statusCode, 200, complete.body);
  const replay = await req("POST", "/api/v1/auth/complete-profile", { onboardingToken: ticket, nickname: "小八" });
  assert.equal(replay.statusCode, 409, replay.body);

  const again = await smsLogin(app, "13700002222");
  assert.equal(again.status, "authenticated");
});

test("新账号强制昵称：昵称规则与冲突", async () => {
  const codeRes = await req("POST", "/api/v1/auth/request-code", { phone: "13600000001" });
  const code = codeRes.json().code as string;
  const login = await req("POST", "/api/v1/auth/login-code", { phone: "13600000001", code });
  const ticket = login.json().onboardingToken as string;

  const bad = await req("POST", "/api/v1/auth/complete-profile", { onboardingToken: ticket, nickname: "123" });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, "INVALID_NICKNAME");

  const clash = await req("POST", "/api/v1/auth/complete-profile", { onboardingToken: ticket, nickname: "测试用户" });
  assert.equal(clash.statusCode, 409);
  assert.equal(clash.json().error.code, "NICKNAME_TAKEN");
});

test("旧邮箱/密码接口统一 410 AUTH_METHOD_REMOVED", async () => {
  for (const url of ["/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/auth/reset-code", "/api/v1/auth/reset-password"]) {
    const res = await req("POST", url, { email: "a@b.com", password: "x", account: "13800000001" });
    assert.equal(res.statusCode, 410, url + " -> " + res.body);
    assert.equal(res.json().error.code, "AUTH_METHOD_REMOVED", url);
  }
  const legacyEntry = await req("POST", "/api/v1/auth/forgot-password", { email: "a@b.com" });
  assert.equal(legacyEntry.statusCode, 404, "邮件找回入口应已从契约中移除");
});

test("未带 token 访问受保护接口返回 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/accounts" });
  assert.equal(res.statusCode, 401);
});

test("me 返回当前用户（仅本人返回手机号）", async () => {
  const res = await req("GET", "/api/v1/auth/me");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user.phone, "+8613800000001");
  assert.equal(res.json().user.nickname, "测试用户");
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
  const { year, month } = currentYearMonth();
  const res = await req("GET", "/api/v1/stats/summary?year=" + year + "&month=" + month);
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
  const { year, month } = currentYearMonth();
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
  const { year, month } = currentYearMonth();

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
  const u = db.select().from(users).where(eq(users.phone, "+8613800000001")).get()!;
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
      updatedAt: now,
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
  const login = await smsLogin(app, "13800000001");
  assert.equal(login.status, "authenticated");
  assert.ok(login.refreshToken, "登录应返回 refreshToken");

  const refresh = await req("POST", "/api/v1/auth/refresh", {
    refreshToken: login.refreshToken,
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
  const login = await smsLogin(app, "13800000001");
  const bad = await app.inject({
    method: "GET",
    url: "/api/v1/accounts",
    headers: { authorization: "Bearer " + login.refreshToken },
  });
  assert.equal(bad.statusCode, 401);
});

// 账号恢复方案（确定采用「短信恢复」）：
// - 邮件 reset-token 通道未接入投递（无 SMTP），契约已从后端/OpenAPI/iOS 全部移除；
// - 手机号账号用「短信验证码 + 新密码」自助恢复；
// - 邮箱账号没有可投递通道 → 明确 400，不再出现「返回成功但拿不到 token」。
test("账号恢复：旧密码找回流程统一 410", async () => {
  // 邮箱/密码恢复流程整体下线 → 410
  const emailRes = await req("POST", "/api/v1/auth/reset-code", { account: "13800000001" });
  assert.equal(emailRes.statusCode, 410, emailRes.body);
  assert.equal(emailRes.json().error.code, "AUTH_METHOD_REMOVED", emailRes.body);

  const reset = await req("POST", "/api/v1/auth/reset-password", { account: "13800000001", code: "123456", newPassword: "x" });
  assert.equal(reset.statusCode, 410, reset.body);

  // 已下线的邮件找回入口必须 404（路由不存在）
  const legacyEntry = await req("POST", "/api/v1/auth/forgot-password", { email: "a@b.com" });
  assert.equal(legacyEntry.statusCode, 404, "邮件找回入口应已从契约中移除");
});

test("健康检查校验数据库可达", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "ok");
});

test("手机号归一化：138…/带空格/+86 视为同一账号", async () => {
  const body = await smsRegister(app, "13800138000", "号码一");
  assert.equal(body.user.phone, "+8613800138000");

  const norm = await smsLogin(app, "138 0013 8000");
  assert.equal(norm.status, "authenticated");
  assert.equal(norm.user.id, body.user.id);

  const plus = await smsLogin(app, "+8613800138000");
  assert.equal(plus.user.id, body.user.id);
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
  // 写入失败必须与"跳过"分开回报（历史缺陷：空 catch 把 FK/CHECK 失败也算成 skipped）
  assert.deepEqual(first.json().failed, [], "成功导入不应有写入失败明细: " + first.body);

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
  const regA = await smsRegister(app, "13810000001", "家人甲");
  const hA = { authorization: "Bearer " + regA.token };
  const idA = regA.user.id as string;
  const regB = await smsRegister(app, "13810000002", "家人乙");
  const hB = { authorization: "Bearer " + regB.token };
  const idB = regB.user.id as string;

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

  // A 按昵称邀请 B，B 接受后成为家庭成员
  const inviteB = await app.inject({
    method: "POST",
    url: `/api/v1/families/${familyId}/invitations`,
    headers: hA,
    payload: { nickname: "家人乙" },
  });
  assert.equal(inviteB.statusCode, 200, inviteB.body);
  const inviteBId = inviteB.json().item.id as string;
  const addB = await app.inject({
    method: "POST",
    url: `/api/v1/families/invitations/${inviteBId}/accept`,
    headers: hB,
    payload: {},
  });
  assert.equal(addB.statusCode, 200, addB.body);

  // B 能看到家庭账本里的账户
  const listB = await app.inject({ method: "GET", url: "/api/v1/accounts?ledgerId=" + familyLedger, headers: hB });
  assert.equal(listB.statusCode, 200, listB.body);
  assert.equal(listB.json().items.length, 1, "家庭成员应能看到共享账本账户");

  // A 的个人默认账本
  const ledgersA = await app.inject({ method: "GET", url: "/api/v1/ledgers", headers: hA });
  const personalA = (ledgersA.json().items as Array<{ id: string; familyId: string | null }>).find((l) => l.familyId === null)!;
  const forbiddenB = await app.inject({ method: "GET", url: "/api/v1/accounts?ledgerId=" + personalA.id, headers: hB });
  assert.equal(forbiddenB.statusCode, 403, "非成员访问个人账本应 403");

  // B 用 A 的共享账户 + 家庭分类记账（家庭共享写入）
  const catsB = await app.inject({ method: "GET", url: "/api/v1/categories?ledgerId=" + familyLedger, headers: hB });
  assert.equal(catsB.statusCode, 200, catsB.body);
  const catB = (catsB.json().items as Array<{ id: string; type: string }>).find((c) => c.type === "expense");
  assert.ok(catB, "家庭成员应能读到家庭分类");

  const accountIdB = (listB.json().items as Array<{ id: string }>)[0]!.id;
  const createByB = await app.inject({
    method: "POST",
    url: "/api/v1/transactions?ledgerId=" + familyLedger,
    headers: hB,
    payload: {
      accountId: accountIdB,
      categoryId: catB!.id,
      type: "expense",
      amount: 3456,
      currency: "CNY",
      date: todayStr(),
      note: "B 在家庭账本记账",
      ledgerId: familyLedger,
    },
  });
  assert.equal(createByB.statusCode, 200, createByB.body);

  const txA = await app.inject({ method: "GET", url: "/api/v1/transactions?ledgerId=" + familyLedger, headers: hA });
  assert.equal(txA.statusCode, 200, txA.body);
  const notes = (txA.json().items as Array<{ note: string | null }>).map((t) => t.note);
  assert.ok(notes.includes("B 在家庭账本记账"), "A 应能看到 B 记的家庭流水");
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

test("贷款创建、还款本金/利息拆分、转账与负债统计", async () => {
  // 还款来源银行卡
  const bank = await req("POST", "/api/v1/accounts", {
    name: "还款卡",
    type: "bank",
    currency: "CNY",
    initialBalance: 5000000,
  });
  assert.equal(bank.statusCode, 200, bank.body);
  const bankId = bank.json().item.id as string;

  // 先创建一个 loan 类型负债账户
  const loanAccount = await req("POST", "/api/v1/accounts", {
    name: "房贷负债",
    type: "loan",
    currency: "CNY",
    initialBalance: 0,
  });
  assert.equal(loanAccount.statusCode, 200, loanAccount.body);
  const loanAccountId = loanAccount.json().item.id as string;

  // 贷款不能绑定普通银行卡作为贷款负债账户（必须 loan 类型）
  const badBind = await req("POST", "/api/v1/loans", {
    name: "非法绑定",
    type: "mortgage",
    principal: 100000,
    annualRate: 4.9,
    termMonths: 12,
    startDate: "2026-01-01",
    liabilityAccountId: bankId,
  });
  assert.equal(badBind.statusCode, 400, "把银行卡绑定为贷款负债账户应失败");

  const created = await req("POST", "/api/v1/loans", {
    name: "房贷",
    type: "mortgage",
    principal: 1_000_000, // 1万元（分）
    annualRate: 4.9,
    termMonths: 12,
    startDate: "2026-01-01",
    accountId: bankId,
    liabilityAccountId: loanAccountId,
  });
  assert.equal(created.statusCode, 200, created.body);
  const loanId = created.json().item.id as string;
  assert.ok(created.json().item.monthlyPayment > 0);
  assert.equal(created.json().item.liabilityAccountId, loanAccountId);

  const detail = await req("GET", "/api/v1/loans/" + loanId);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().schedule.length, 12);

  const firstPayDue = detail.json().schedule[0] as { principalDue: number; interestDue: number; total: number; installmentNo: number };
  const principalPart = firstPayDue.principalDue;
  const interestPart = firstPayDue.interestDue;
  assert.ok(principalPart > 0 && interestPart > 0, "首期应含本金与利息");

  // 还款：用银行卡还第一期（偿还下一期必须携带幂等键）
  const pay = await req("POST", "/api/v1/loans/" + loanId + "/pay", { payFromAccountId: bankId, date: todayStr(), idempotencyKey: "api-test-pay-1" });
  assert.equal(pay.statusCode, 200, pay.body);
  const payBody = pay.json();
  assert.ok(payBody.paymentGroupId, "还款应返回 paymentGroupId");
  assert.ok(payBody.principalTransactionId && payBody.interestTransactionId, "应返回本金/利息两条流水 id");

  const txs = await req("GET", "/api/v1/transactions");
  const items = txs.json().items as Array<{ id: string; accountId: string; transferToAccountId: string | null; type: string; sourceType: string; amount: number; paymentGroupId: string | null }>;
  // 本金转账：银行卡 → 贷款负债账户，不计入收支
  const principalTx = items.find((t) => t.id === payBody.principalTransactionId);
  assert.ok(principalTx, "本金转账应存在");
  assert.equal(principalTx!.type, "transfer");
  assert.equal(principalTx!.accountId, bankId);
  assert.equal(principalTx!.transferToAccountId, loanAccountId, "本金转账目标为贷款负债账户");
  assert.equal(principalTx!.amount, principalPart, "本金转账金额为本金部分");
  assert.equal(principalTx!.paymentGroupId, payBody.paymentGroupId, "本金与利息共用 paymentGroupId");
  // 利息支出：银行卡 → 支出，计入消费
  const interestTx = items.find((t) => t.id === payBody.interestTransactionId);
  assert.ok(interestTx, "利息支出应存在");
  assert.equal(interestTx!.type, "expense");
  assert.equal(interestTx!.accountId, bankId);
  assert.equal(interestTx!.amount, interestPart, "利息支出金额为利息部分");
  assert.equal(interestTx!.paymentGroupId, payBody.paymentGroupId, "利息与本金共用 paymentGroupId");

  const liabilities = await req("GET", "/api/v1/liabilities");
  assert.equal(liabilities.statusCode, 200, liabilities.body);
  const loan = (liabilities.json().loans as Array<{ id: string; remainingPrincipal: number; liabilityAccountId: string | null }>).find((l) => l.id === loanId);
  assert.ok(loan, "负债列表应包含贷款");
  assert.equal(loan!.liabilityAccountId, loanAccountId);
  assert.equal(loan!.remainingPrincipal, 1_000_000 - principalPart, "剩余本金只减少本金部分");

  // 审计日志记录本次还款（含本金/利息拆分）
  const audit = await req("GET", "/api/v1/audit-logs?entityType=loan&entityId=" + loanId);
  assert.equal(audit.statusCode, 200, audit.body);
  const payAudit = (audit.json().items as Array<{ action: string; after: { principal: number; interest: number; paymentGroupId: string } }>).find((a) => a.action === "loan_pay");
  assert.ok(payAudit, "审计日志应包含 loan_pay 记录");
  assert.equal(payAudit!.after.principal, principalPart);
  assert.equal(payAudit!.after.interest, interestPart);
  assert.equal(payAudit!.after.paymentGroupId, payBody.paymentGroupId);

  // 资产负债恒等：银行减少总月供，负债只减少本金；利息计入支出、本金不计入支出
  // （用增量断言，避免测试库中其他月份/历史流水干扰绝对数值）
  const summaryUrl = `/api/v1/stats/summary?year=${todayStr().slice(0, 4)}&month=${Number(todayStr().slice(5, 7))}`;
  const second = detail.json().schedule[1] as { principalDue: number; interestDue: number };
  const beforePay = (await req("GET", summaryUrl)).json();
  const txsBefore = (await req("GET", "/api/v1/transactions")).json().items.length as number;
  const paySecond = await req("POST", "/api/v1/loans/" + loanId + "/pay", { payFromAccountId: bankId, date: todayStr(), idempotencyKey: "api-test-pay-2" });
  assert.equal(paySecond.statusCode, 200, paySecond.body);
  const s = (await req("GET", summaryUrl)).json();
  const txsAfter = (await req("GET", "/api/v1/transactions")).json().items.length as number;
  assert.equal(s.expense - beforePay.expense, second.interestDue, "第二期利息应计入当月支出，本金不计入");
  assert.equal(txsAfter - txsBefore, 2, "第二期仍只新增 2 条流水（本金+利息）");
  const remainingAfterSecond = 1_000_000 - principalPart - second.principalDue;
  // 用增量验证负债（避免测试库中其他历史负债干扰绝对数值）
  assert.equal(s.totalDebt, beforePay.totalDebt - second.principalDue, "负债随还款只减少本金部分");

  // 还款后负债账户余额应等于 -(剩余本金)
  const accountsRes = await req("GET", "/api/v1/accounts");
  const loanAcctOut = (accountsRes.json().items as Array<{ id: string; balance: number; isLiability: boolean }>).find((a) => a.id === loanAccountId);
  assert.ok(loanAcctOut, "负债账户应存在");
  assert.equal(loanAcctOut!.isLiability, true, "loan 类型账户标记为负债");
  assert.equal(loanAcctOut!.balance, -remainingAfterSecond, "负债账户余额 = -(剩余本金)，不重复计负债");

  // 继续还完全部剩余期次后返回已还清；再还返回 400 LOAN_PAID_OFF
  for (let i = 0; i < 10; i++) {
    const r = await req("POST", "/api/v1/loans/" + loanId + "/pay", { payFromAccountId: bankId, date: todayStr(), idempotencyKey: "api-test-pay-" + (i + 3) });
    assert.equal(r.statusCode, 200, `补还第 ${i + 3} 期失败: ${r.body}`);
  }
  const over = await req("POST", "/api/v1/loans/" + loanId + "/pay", { payFromAccountId: bankId, date: todayStr(), idempotencyKey: "api-test-pay-13" });
  assert.equal(over.statusCode, 400, "还清后再还款应返回 400");
  assert.match(over.body, /LOAN_PAID_OFF/);
});

test("贷款不传负债账户时自动创建 loan 类型账户", async () => {
  const bank = await req("POST", "/api/v1/accounts", {
    name: "还款卡2",
    type: "bank",
    currency: "CNY",
    initialBalance: 1000000,
  });
  const bankId = bank.json().item.id as string;
  const created = await req("POST", "/api/v1/loans", {
    name: "车贷",
    type: "car",
    principal: 500000,
    annualRate: 0,
    termMonths: 10,
    startDate: "2026-01-01",
    accountId: bankId,
  });
  assert.equal(created.statusCode, 200, created.body);
  const liabilityAccountId = created.json().item.liabilityAccountId as string;
  assert.ok(liabilityAccountId, "应自动创建负债账户");
  const accountsRes = await req("GET", "/api/v1/accounts");
  const acct = (accountsRes.json().items as Array<{ id: string; type: string; balance: number }>).find((a) => a.id === liabilityAccountId);
  assert.ok(acct, "自动创建的负债账户应存在");
  assert.equal(acct!.type, "loan");
  assert.equal(acct!.balance, -500000, "自动创建时负余额 = 贷款本金");
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

test("信用卡账单创建、还款生成转账并标记已还", async () => {
  const credit = await req("POST", "/api/v1/accounts", {
    name: "信用卡账单测试",
    type: "credit",
    currency: "CNY",
    initialBalance: 0,
  });
  assert.equal(credit.statusCode, 200, credit.body);
  const accountId = credit.json().item.id as string;

  const bank = await req("POST", "/api/v1/accounts", {
    name: "还款银行卡",
    type: "bank",
    currency: "CNY",
    initialBalance: 100000,
  });
  assert.equal(bank.statusCode, 200, bank.body);
  const bankId = bank.json().item.id as string;

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

  // 直接 PATCH paid=true 必须被拒绝（不能只改已还状态）
  const reject = await req("PATCH", `/api/v1/credit-card-bills/${bill!.id}`, { paid: true });
  assert.equal(reject.statusCode, 400, "直接标记已还应被拒绝");

  // 走还款接口：生成还款账户→信用卡的转账
  const pay = await req("POST", `/api/v1/credit-card-bills/${bill!.id}/pay`, {
    payFromAccountId: bankId,
    payDate: "2026-08-26",
  });
  assert.equal(pay.statusCode, 200, pay.body);
  assert.ok(pay.json().transactionId, "应返回生成的转账流水 id");

  // 流水中应有该笔转账（转出为银行卡）
  const txs = await req("GET", "/api/v1/transactions");
  assert.equal(txs.statusCode, 200, txs.body);
  const transfer = (txs.json().items as Array<{ id: string; type: string; accountId: string; transferToAccountId: string; amount: number }>).find(
    (t) => t.id === pay.json().transactionId,
  );
  assert.ok(transfer, "应能查到还款转账");
  assert.equal(transfer!.type, "transfer");
  assert.equal(transfer!.accountId, bankId);
  assert.equal(transfer!.transferToAccountId, accountId);
  assert.equal(transfer!.amount, 10000);

  // 账单已标记为已还
  const after = await req("GET", "/api/v1/credit-card-bills");
  const paidBill = (after.json().items as Array<{ id: string; paid: boolean }>).find((b) => b.id === bill!.id);
  assert.equal(paidBill!.paid, true, "还款后账单应为已还");

  // 再次还款应 409
  const again = await req("POST", `/api/v1/credit-card-bills/${bill!.id}/pay`, { payFromAccountId: bankId });
  assert.equal(again.statusCode, 409, "已还账单不能重复还款");
});

test("越权防护：B 看不到 A 账本的信用卡账单", async () => {
  const regA = await smsRegister(app, "13820000001", "信用卡甲");
  const hA = { authorization: "Bearer " + regA.token };

  const regB = await smsRegister(app, "13820000002", "信用卡乙");
  const hB = { authorization: "Bearer " + regB.token };

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

test("信用卡账单：同一账户同一期不可重复创建（409）", async () => {
  const acc = await req("POST", "/api/v1/accounts", {
    name: "信用卡去重测试",
    type: "credit",
    currency: "CNY",
    initialBalance: 0,
  });
  assert.equal(acc.statusCode, 200, acc.body);
  const accountId = acc.json().item.id as string;

  const first = await req("POST", `/api/v1/credit-cards/${accountId}/bills`, {
    period: "2026-10",
    statementBalance: 5000,
  });
  assert.equal(first.statusCode, 200, first.body);

  const dup = await req("POST", `/api/v1/credit-cards/${accountId}/bills`, {
    period: "2026-10",
    statementBalance: 6000,
  });
  assert.equal(dup.statusCode, 409, "同一期重复创建应返回 409");
  assert.equal(dup.json().error.code, "BILL_PERIOD_EXISTS");
});

test("导入暂存流程：建任务→预览→提交，不静默丢弃", async () => {
  // 确保有默认账户
  const acc = await req("POST", "/api/v1/accounts", {
    name: "导入暂存账户",
    type: "bank",
    currency: "CNY",
    initialBalance: 0,
  });
  assert.equal(acc.statusCode, 200, acc.body);

  // 创建暂存任务（2 条）
  const create = await req("POST", "/api/v1/imports/jobs", {
    mode: "items",
    items: [
      { date: todayStr(), amount: 1111, type: "expense", note: "暂存A", externalId: "stage-a" },
      { date: todayStr(), amount: 2222, type: "expense", note: "暂存B", externalId: "stage-b" },
    ],
  });
  assert.equal(create.statusCode, 200, create.body);
  const jobId = create.json().item.id as string;
  assert.equal(create.json().item.status, "staged");
  assert.equal(create.json().counts.total, 2);

  // 查看明细（2 条都是 new 且默认 accept）
  const detail = await req("GET", "/api/v1/imports/jobs/" + jobId);
  assert.equal(detail.statusCode, 200, detail.body);
  const items = detail.json().items as Array<{ id: string; duplicateStatus: string; decision: string }>;
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.duplicateStatus === "new"));

  // 跳过其中一条，另一条提交
  const skip = await req("PATCH", `/api/v1/imports/items/${items[0]!.id}`, { decision: "skip" });
  assert.equal(skip.statusCode, 200, skip.body);

  const commit = await req("POST", `/api/v1/imports/jobs/${jobId}/commit`);
  assert.equal(commit.statusCode, 200, commit.body);
  assert.equal(commit.json().imported, 1, "只导入 accept 的一条");
  assert.equal(commit.json().skipped, 1, "skip 的计入 skipped（不含重复跳过）");

  // 正式流水里应能查到被导入的那条
  const txs = await req("GET", "/api/v1/transactions");
  const names = (txs.json().items as Array<{ note: string | null }>).map((t) => t.note);
  assert.ok(names.includes("暂存B"), "提交的明细进入正式流水");
  assert.ok(!names.includes("暂存A"), "被 skip 的明细不进入正式流水");
});

test("导入 multipart 文件上传：解析建任务且记 SHA-256", async () => {
  const acc = await req("POST", "/api/v1/accounts", {
    name: "multipart导入账户",
    type: "bank",
    currency: "CNY",
    initialBalance: 0,
  });
  assert.equal(acc.statusCode, 200, acc.body);

  const content = `微信支付账单明细
交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
2026-08-20 12:00:00,商户消费,某店,外卖,支出,¥12.00,零钱,支付成功,100001,200001,测试`;

  const boundary = "----TallyTestBoundary1234";
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="source"\r\n\r\nwechat\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="wechat.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n`,
    `--${boundary}--\r\n`,
  ];
  const body = parts.join("");

  const up = await app.inject({
    method: "POST",
    url: "/api/v1/imports/jobs/upload",
    headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal(up.statusCode, 200, up.body);
  assert.equal(up.json().item.source, "wechat");
  assert.equal(up.json().counts.total, 1, "应解析出 1 条明细");
  assert.ok(up.json().item.fileHash, "应记录 file SHA-256");
  assert.match(up.json().item.fileHash, /^[a-f0-9]{64}$/, "SHA-256 应为 64 位 hex");
});

// 契约覆盖：把「已注册路由」与「契约声明的操作」做集合相等校验。
//
// 历史缺陷：这里原先是 openapi.includes(path) 的子串断言 + 29 条手写子集，
// 于是 78 个已注册操作里有 26 个从未出现在契约里（/auth/me、transactions/{id}、
// 全部 budgets/recurring/stats 等），且 openapi.yaml 改了错枚举也没人发现。
// 现在改为：解析 YAML → 归一化路径参数 → 与运行时路由表做双向差集，任一侧多出即失败。
function registeredOperations(): Set<string> {
  // printRoutes({ commonPrefix: false }) 是一棵树：子节点只打印相对片段，
  // 每层缩进 4 字符（"│   " 或 "    "），必须按深度重建完整路径——
  // 直接用正则抓路径会得到 "DELETE /:id" 这类残缺值。
  const stack: string[] = [];
  const ops = new Set<string>();
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const m = line.match(/^((?:[│ ]   )*)(?:├── |└── )(\S+)\s+\(([A-Z, ]+)\)\s*$/);
    if (!m) continue;
    const depth = m[1].length / 4;
    const full = depth === 0 ? m[2] : stack[depth - 1] + m[2];
    stack[depth] = full;
    for (const method of m[3].split(",").map((x) => x.trim())) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      ops.add(method + " " + full);
    }
  }
  return ops;
}

function specOperations(): Set<string> {
  const doc = YAML.parse(readFileSync(resolve("../docs/openapi.yaml"), "utf8")) as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const ops = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      ops.add(method.toUpperCase() + " " + path.replace(/\{([^}]+)\}/g, ":$1"));
    }
  }
  return ops;
}

test("OpenAPI 契约与已注册路由集合相等（双向差集为空）", async () => {
  await app.ready();
  const registered = registeredOperations();
  const spec = specOperations();

  const missingInSpec = [...registered].filter((k) => !spec.has(k)).sort();
  const extraInSpec = [...spec].filter((k) => !registered.has(k)).sort();

  assert.deepEqual(
    missingInSpec,
    [],
    "以下已注册路由未写入 docs/openapi.yaml（契约漂移，客户端按契约实现会漏接口）：\n  " +
      missingInSpec.join("\n  "),
  );
  assert.deepEqual(
    extraInSpec,
    [],
    "以下契约端点并未在服务端注册（文档写了不存在的接口）：\n  " + extraInSpec.join("\n  "),
  );
  assert.ok(registered.size >= 70, "路由数量异常偏少，可能解析出错: " + registered.size);
});

test("OpenAPI 关键契约细节：公开端点免鉴权 + 账户类型枚举与实现一致", async () => {
  const doc = YAML.parse(readFileSync(resolve("../docs/openapi.yaml"), "utf8")) as {
    security?: unknown[];
    paths: Record<string, Record<string, { security?: unknown[] }>>;
  };

  // 顶层 security 是"默认可选"的声明；免鉴权端点必须显式覆盖为 []
  const publicPaths = [
    "/health",
    "/health/live",
    "/health/ready",
    "/api/v1/auth/request-code",
    "/api/v1/auth/login-code",
    "/api/v1/auth/complete-profile",
    "/api/v1/auth/refresh",
    "/api/v1/users/nickname-availability",
  ];
  for (const p of publicPaths) {
    const item = doc.paths[p];
    assert.ok(item, `契约应包含公开端点 ${p}`);
    const op = item.get ?? item.post ?? {};
    assert.deepEqual(op.security, [], `${p} 是免鉴权端点，契约必须写 security: []（否则客户端会误加鉴权头）`);
  }

  // 账户类型枚举必须与 accounts.ts 的 ACCOUNT_TYPES 完全一致
  const accountEnum = (
    doc.paths["/api/v1/accounts"]!.post!.requestBody as {
      content: { "application/json": { schema: { properties: { type: { enum: string[] } } } } };
    }
  ).content["application/json"].schema.properties.type.enum;
  assert.deepEqual(
    [...accountEnum].sort(),
    ["bank", "cash", "credit", "e-wallet", "loan", "other"].sort(),
    "账户类型枚举必须与后端 ACCOUNT_TYPES 一致（历史文档写的是 wallet/investment/credit_card）",
  );

  // 邮件找回入口必须彻底不在契约里
  const raw = readFileSync(resolve("../docs/openapi.yaml"), "utf8");
  assert.ok(!raw.includes("/api/v1/auth/forgot-password"), "OpenAPI 不应再包含邮件找回入口");
  assert.ok(!raw.includes("resetToken"), "OpenAPI 不应再有 resetToken 契约");
});

test("OpenAPI 文档可解析、operationId 唯一、路径均为合法前缀", async () => {
  const openapi = readFileSync(resolve("../docs/openapi.yaml"), "utf8");

  // 顶层结构（OpenAPI 3.0 必需字段）
  assert.match(openapi, /^openapi:\s*3\.0/m, "应声明 OpenAPI 3.0");
  assert.match(openapi, /^info:\s*$/m, "应有 info 块");
  assert.match(openapi, /^paths:\s*$/m, "应有 paths 块");

  // 路径条目均为合法前缀
  for (const line of openapi.split("\n")) {
    const m = line.match(/^  (\/(api\/v1\/\S+|health(?:\/\S+)?)):\s*$/);
    if (m) {
      const name = m[1]!;
      assert.ok(/^\/api\/v1\//.test(name) || name.startsWith("/health"), `路径应为合法前缀: ${name}`);
    }
  }

  // operationId 唯一性
  const opIds = [...openapi.matchAll(/^[ ]+operationId:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
  assert.ok(opIds.length >= 25, `应至少有 25 个 operationId，实际 ${opIds.length}`);
  const seen = new Set<string>();
  const dupes = opIds.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(dupes, [], `operationId 不应重复: ${dupes.join(", ")}`);
});
