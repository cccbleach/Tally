process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { smsRegister } from "./helpers.js";

// 流水客户端幂等键回归（离线写队列的地基）：
//   1) 同一 clientRequestId 重复 POST → 返回首次创建的流水，不重复入账；
//   2) 并发两个相同键请求 → 唯一索引兜底，只有一个入账，双方都拿到同一笔；
//   3) 不带键 → 维持原有行为（每 POST 一条）。
// 离线队列重放时网络可能"请求已到达但响应丢失"，靠这个键保证至多一次入账。
let app: FastifyInstance;
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;
let H: Record<string, string>;

function req(method: string, url: string, body?: unknown) {
  const h = { ...H };
  if (body !== undefined) h["content-type"] = "application/json";
  return app.inject({ method, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-clientreq-"));
  const created = createDb(join(dir, "tally.db"));
  sqlite = created.sqlite;
  const candidates = [resolve("./migrations"), resolve("../migrations")];
  runMigrations(sqlite, candidates.find((c) => existsSync(c)) ?? candidates[0]);
  app = await buildApp({ db: created.db, jwtSecret: "x".repeat(40) });
  const body = await smsRegister(app, "+8613800000222", "幂等键测试");
  H = { authorization: "Bearer " + body.token };
});

after(async () => {
  await app.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

async function setupAccountAndCategory() {
  const account = await req("POST", "/api/v1/accounts", { name: "微信钱包", type: "e-wallet", initialBalance: 0 });
  assert.equal(account.statusCode, 200, account.body);
  const category = await req("POST", "/api/v1/categories", { name: "餐饮", type: "expense" });
  assert.equal(category.statusCode, 200, category.body);
  return { accountId: account.json().item.id as string, categoryId: category.json().item.id as string };
}

test("同一 clientRequestId 重复提交返回首次流水，不重复入账", async () => {
  const { accountId, categoryId } = await setupAccountAndCategory();
  const payload = {
    type: "expense",
    amount: 2500,
    date: "2026-09-12",
    accountId,
    categoryId,
    note: "咖啡",
    clientRequestId: "queued-0001",
  };
  const first = await req("POST", "/api/v1/transactions", payload);
  assert.equal(first.statusCode, 200, first.body);
  const firstId = first.json().item.id as string;

  // 重放：网络重发/离线队列重试（即使金额被改了也按幂等键返回首次结果）
  const replay = await req("POST", "/api/v1/transactions", { ...payload, amount: 9999 });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().item.id, firstId, "重放必须返回首次创建的流水");
  assert.equal(replay.json().item.amount, 2500, "重放返回的是首次内容，不是本次请求内容");

  const list = await req("GET", "/api/v1/transactions?limit=200");
  assert.equal(list.json().total, 1, "幂等键相同的重复提交只入账一次");
});

test("并发两个相同键请求：唯一索引兜底，只有一个入账且双方同结果", async () => {
  const { accountId, categoryId } = await setupAccountAndCategory();
  const payload = {
    type: "expense",
    amount: 1000,
    date: "2026-09-12",
    accountId,
    categoryId,
    clientRequestId: "queued-concurrent-0002",
  };
  const totalBefore = ((await req("GET", "/api/v1/transactions?limit=1")).json().total) as number;

  const [a, b] = await Promise.all([
    req("POST", "/api/v1/transactions", payload),
    req("POST", "/api/v1/transactions", payload),
  ]);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(a.json().item.id, b.json().item.id, "并发方必须拿到同一笔流水（至多一次入账）");

  // total 是账本级累计：只断言「本次并发恰好新增一条」
  const totalAfter = ((await req("GET", "/api/v1/transactions?limit=1")).json().total) as number;
  assert.equal(totalAfter, totalBefore + 1, "并发下仍只入账一次");
});

test("不带 clientRequestId 维持原行为：每条独立入账", async () => {
  const { accountId, categoryId } = await setupAccountAndCategory();
  const payload = {
    type: "expense",
    amount: 100,
    date: "2026-09-12",
    accountId,
    categoryId,
  };
  const a = await req("POST", "/api/v1/transactions", payload);
  const b = await req("POST", "/api/v1/transactions", payload);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.notEqual(a.json().item.id, b.json().item.id);
});

test("幂等键格式非法被 zod 拒绝（空格/特殊字符/过短）", async () => {
  const { accountId, categoryId } = await setupAccountAndCategory();
  const base = { type: "expense", amount: 100, date: "2026-09-12", accountId, categoryId };
  for (const bad of ["", "abc", "has space", "中文键值", "a".repeat(65)]) {
    const res = await req("POST", "/api/v1/transactions", { ...base, clientRequestId: bad });
    assert.equal(res.statusCode, 400, `非法幂等键 ${JSON.stringify(bad)} 应被拒绝`);
  }
});
