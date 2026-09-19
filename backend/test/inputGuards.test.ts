// 输入护栏回归：
//   1) 不存在的日期（2026-02-31）过去只过正则，会被 parseDateStr 静默滚成 3 月 3 日
//   2) ?month=13 / ?year=abc 过去返回 200 + 空统计，掩盖参数错误
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
import { transactions } from "../src/db/schema.js";
import { smsRegister } from "./helpers.js";

let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;
let H: Record<string, string>;
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
  const acct = { statusCode: 200 }; // 账户域已下线：不再需要先建账户
  assert.equal(acct.statusCode, 200, acct.body);
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
      categoryId, type: "expense", amount: 100, date: bad,
    });
    assert.equal(res.statusCode, 400, `${bad} 应被拒绝: ` + res.body);
    assert.equal(res.json().error.code, "VALIDATION", bad + " 应返回 VALIDATION");
    assert.match(res.json().error.message, /日期/, bad + " 的报错必须是日期本身（否则等于没测到日期校验）");
  }
  // 合法日期（含闰年 2 月 29）必须照常通过
  for (const good of ["2024-02-29", "2026-02-28", "2026-12-31"]) {
    const res = await req("POST", "/api/v1/transactions", {
      categoryId, type: "expense", amount: 100, date: good,
    });
    assert.equal(res.statusCode, 200, `${good} 应被接受: ` + res.body);
  }
  // 周期性账单的 startDate/endDate 同样受保护
  const recurring = await req("POST", "/api/v1/recurring", {
    type: "expense", amount: 100, frequency: "monthly",
    startDate: "2026-02-31",
  });
  assert.equal(recurring.statusCode, 400, "周期账单起始日不合法应 400: " + recurring.body);
});

test("year/month 查询参数：非法值返回 400 而不是空统计", async () => {
  for (const q of ["month=13", "month=0", "month=abc", "year=abc", "year=0"]) {
    const res = await req("GET", `/api/v1/stats/summary?${q}`);
    assert.equal(res.statusCode, 400, `${q} 应 400: ` + res.body);
  }
  // 合法值与缺省值仍照常工作
  assert.equal((await req("GET", "/api/v1/stats/summary?year=2026&month=2")).statusCode, 200);
  assert.equal((await req("GET", "/api/v1/stats/summary")).statusCode, 200);
});
