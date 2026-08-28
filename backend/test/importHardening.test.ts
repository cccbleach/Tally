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
import { transactions } from "../src/db/schema.js";

// 导入加固（阶段 4）验收：
// - 硬去重只用稳定来源 ID（同账本同来源同 external_id）
// - 启发式 dedup_key 不再做数据库硬唯一，两笔同商家同金额可共存
// - 疑似重复选择 accept 后确实写入
// - 提交过程中硬去重冲突返回明确错误，不静默丢弃

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
  dir = mkdtempSync(join(tmpdir(), "tally-import-hardening-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "test-secret" });

  const res = await req("POST", "/api/v1/auth/register", {
    email: "import@test.com",
    password: "password123",
    displayName: "导入测试",
  });
  headers = { authorization: "Bearer " + res.json().token };
  // 创建账户和分类，供导入默认映射
  await req("POST", "/api/v1/accounts", { name: "储蓄卡", type: "bank", currency: "CNY" });
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("两笔同商家同金额同日期但外部 ID 不同：可都保留（dedup_key 不再硬唯一）", async () => {
  const create = await req("POST", "/api/v1/imports/jobs", {
    mode: "items",
    source: "wechat",
    items: [
      { date: todayStr(), amount: 999, type: "expense", note: "星巴克咖啡", externalId: "wx-1001" },
      { date: todayStr(), amount: 999, type: "expense", note: "（特约）星巴克咖啡", externalId: "wx-1002" },
    ],
  });
  assert.equal(create.statusCode, 200, create.body);
  const jobId = create.json().item.id;
  const detail = await req("GET", `/api/v1/imports/jobs/${jobId}`);
  assert.equal(detail.statusCode, 200);
  const items = detail.json().items;
  assert.equal(items.length, 2);
  // 两笔的 dedup_key 相同（软去重），第二笔被标记为疑似/重复
  assert.equal(items[0].dedupKey, items[1].dedupKey, "两笔应有相同启发式指纹");
  assert.equal(items[0].duplicateStatus, "new");
  assert.equal(items[1].duplicateStatus, "duplicate");
  assert.equal(items[0].source, "wechat");
  // 第二条改为 accept（人工确认保留）
  await req("PATCH", `/api/v1/imports/items/${items[1].id}`, { decision: "accept" });
  const commit = await req("POST", `/api/v1/imports/jobs/${jobId}/commit`);
  assert.equal(commit.statusCode, 200, commit.body);
  assert.equal(commit.json().imported, 2, "两笔都应写入，不再被硬唯一拦截");
  const rows = db
    .select()
    .from(transactions)
    .where(eq(transactions.ledgerId, detail.json().job.ledgerId))
    .all();
  const imports = rows.filter((r) => r.externalId === "wx-1001" || r.externalId === "wx-1002");
  assert.equal(imports.length, 2, "两笔正式流水都在");
});

test("硬去重：同账本同来源同 external_id 提交冲突返回明确错误", async () => {
  // 先用暂存流程写入一笔 wechat 来源 ext-hard-001（sourceType 会被保存为 wechat）
  const baseJob = await req("POST", "/api/v1/imports/jobs", {
    mode: "items",
    source: "wechat",
    items: [{ date: todayStr(), amount: 555, type: "expense", note: "硬去重测试", externalId: "ext-hard-001" }],
  });
  const baseCommit = await req("POST", `/api/v1/imports/jobs/${baseJob.json().item.id}/commit`);
  assert.equal(baseCommit.statusCode, 200, baseCommit.body);
  assert.equal(baseCommit.json().imported, 1);

  // 暂存同一来源同一 external 的重复项
  const create = await req("POST", "/api/v1/imports/jobs", {
    mode: "items",
    source: "wechat",
    items: [{ date: todayStr(), amount: 555, type: "expense", note: "硬去重测试", externalId: "ext-hard-001" }],
  });
  const jobId = create.json().item.id;
  const detail = await req("GET", `/api/v1/imports/jobs/${jobId}`);
  const item = detail.json().items[0];
  assert.equal(item.duplicateStatus, "duplicate", "硬去重应直接标记重复");
  // 用户强行 accept
  await req("PATCH", `/api/v1/imports/items/${item.id}`, { decision: "accept" });
  const commit = await req("POST", `/api/v1/imports/jobs/${jobId}/commit`);
  assert.equal(commit.statusCode, 409, "硬去重冲突应返回 409 而非静默丢弃");
  assert.equal(commit.json().error.code, "IMPORT_HARD_DUPLICATE");
});

test("暂存提交后的流水能参与下一次软去重", async () => {
  // 第一次：写入一笔“午餐”
  const c1 = await req("POST", "/api/v1/imports/jobs", {
    mode: "items",
    source: "alipay",
    items: [{ date: todayStr(), amount: 3000, type: "expense", note: "食堂午餐", externalId: "ali-1" }],
  });
  await req("POST", `/api/v1/imports/jobs/${c1.json().item.id}/commit`);
  // 第二次：同指纹不同外部 ID → 应被软去重标记 duplicate
  const c2 = await req("POST", "/api/v1/imports/jobs", {
    mode: "items",
    source: "bank",
    items: [{ date: todayStr(), amount: 3000, type: "expense", note: "食堂午餐（特约）", externalId: "bank-1" }],
  });
  const detail = await req("GET", `/api/v1/imports/jobs/${c2.json().item.id}`);
  assert.equal(detail.json().items[0].duplicateStatus, "duplicate", "应命中已有流水的软去重");
  assert.ok(detail.json().items[0].matchedTransactionId, "应指出匹配的正式流水");
});

test("导入明细可逐项覆盖账户与分类", async () => {
  const acct = await req("POST", "/api/v1/accounts", { name: "现金", type: "cash", currency: "CNY" });
  const accountId = acct.json().item.id;
  const cats = await req("GET", "/api/v1/categories");
  const expenseCat = cats.json().items.find((c: { type: string }) => c.type === "expense");
  const create = await req("POST", "/api/v1/imports/jobs", {
    mode: "items",
    source: "alipay",
    items: [{ date: todayStr(), amount: 1234, type: "expense", note: "覆盖测试", externalId: "ali-cover-1" }],
  });
  const jobId = create.json().item.id;
  const detail = await req("GET", `/api/v1/imports/jobs/${jobId}`);
  const item = detail.json().items[0];
  const patch = await req("PATCH", `/api/v1/imports/items/${item.id}`, { accountId, categoryId: expenseCat.id });
  assert.equal(patch.statusCode, 200, patch.body);
  const detail2 = await req("GET", `/api/v1/imports/jobs/${jobId}`);
  assert.equal(detail2.json().items[0].accountId, accountId);
  assert.equal(detail2.json().items[0].categoryId, expenseCat.id);
  const commit = await req("POST", `/api/v1/imports/jobs/${jobId}/commit`);
  assert.equal(commit.statusCode, 200, commit.body);
  const row = db
    .select()
    .from(transactions)
    .where(eq(transactions.externalId, "ali-cover-1"))
    .get();
  assert.ok(row, "应写入正式流水");
  assert.equal(row!.accountId, accountId, "应使用用户选择的账户");
  assert.equal(row!.categoryId, expenseCat.id, "应使用用户选择的分类");
});
