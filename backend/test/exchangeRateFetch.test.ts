process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { getRate, setRate } from "../src/lib/currency.js";
import {
  fetchAndStoreGlobalRates,
  parseRatesPayload,
  runExchangeRateFetchSafely,
  type FetchLike,
} from "../src/lib/exchangeRateFetcher.js";

// 汇率自动拉取（opt-in）回归：
//   1) 解析：合法 payload 过滤脏数据（非 3 字母码/非数字/基准币种自身/非正数）；
//   2) 写入：upsert 到全局兜底表（userId IS NULL），getRate 可读；
//   3) 用户级手工汇率优先于全局自动汇率（自动拉取不覆盖用户设置）；
//   4) 失败安全：网络/HTTP/解析错误不抛出到调度层，且绝不删除已有汇率。
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "tally-rates-"));
  const created = createDb(join(dir, "tally.db"));
  sqlite = created.sqlite;
  db = created.db;
  const candidates = [resolve("./migrations"), resolve("../migrations")];
  runMigrations(sqlite, candidates.find((c) => existsSync(c)) ?? candidates[0]);
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function payloadFetch(payload: unknown, status = 200): FetchLike {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as FetchLike;
}

test("解析：过滤脏数据并排除基准币种自身", () => {
  const parsed = parseRatesPayload({
    result: "success",
    base_code: "cny",
    rates: {
      USD: 0.139,
      JPY: 20.8,
      "not-a-code": 1,
      "  eur  ": 0.128,
      BAD: "not-number",
      NEG: -3,
      ZERO: 0,
      CNY: 1,
    },
  });
  assert.equal(parsed.base, "CNY", "base_code 归一为大写");
  assert.deepEqual(Object.keys(parsed.rates).sort(), ["EUR", "JPY", "USD"]);
});

test("解析：失败状态 / 缺字段 / 空汇率 拒绝", () => {
  assert.throws(() => parseRatesPayload({ result: "error", base_code: "CNY", rates: {} }), /失败状态/);
  assert.throws(() => parseRatesPayload({ result: "success", rates: { USD: 1 } }), /base_code/);
  assert.throws(() => parseRatesPayload({ result: "success", base_code: "CNY", rates: { XX: 1 } }), /没有可用/);
  assert.throws(() => parseRatesPayload("not-an-object"), /JSON 对象/);
});

test("拉取写入全局兜底汇率，且可 upsert 更新", async () => {
  const first = await fetchAndStoreGlobalRates(
    db,
    "https://rates.example/latest",
    payloadFetch({ result: "success", base_code: "CNY", rates: { USD: 7.2, JPY: 0.05 } }),
  );
  assert.equal(first.base, "CNY");
  assert.equal(first.stored, 2);
  assert.equal(getRate(db, "user-1", "USD", "CNY"), 7.2);
  assert.equal(getRate(db, "user-1", "JPY", "CNY"), 0.05);

  // 第二次拉取（汇率变化）→ upsert 覆盖全局值
  await fetchAndStoreGlobalRates(
    db,
    "https://rates.example/latest",
    payloadFetch({ result: "success", base_code: "CNY", rates: { USD: 7.35, JPY: 0.052 } }),
  );
  assert.equal(getRate(db, "user-1", "USD", "CNY"), 7.35, "全局兜底汇率应被新拉取值覆盖");
});

test("用户级手工汇率优先：自动拉取不覆盖用户设置", async () => {
  setRate(db, "user-2", "CNY", "USD", 7.0);
  await fetchAndStoreGlobalRates(
    db,
    "https://rates.example/latest",
    payloadFetch({ result: "success", base_code: "CNY", rates: { USD: 7.9 } }),
  );
  assert.equal(getRate(db, "user-2", "USD", "CNY"), 7.0, "用户级汇率优先于全局自动汇率");
  assert.equal(getRate(db, "another-user", "USD", "CNY"), 7.9, "其他用户仍读到全局兜底值");
});

test("失败安全：HTTP 错误/网络异常不抛出且保留现有汇率", async () => {
  setRate(db, null, "CNY", "USD", 7.2);
  const before = getRate(db, "anyone", "USD", "CNY");

  const httpFailed = await runExchangeRateFetchSafely(db, "https://rates.example/latest", payloadFetch(null, 503));
  assert.equal(httpFailed, false);

  // 直接对 fetchAndStoreGlobalRates 断言抛错（调度层包装前的行为）
  await assert.rejects(
    () =>
      fetchAndStoreGlobalRates(
        db,
        "https://rates.example/latest",
        (() => {
          throw new Error("network down");
        }) as unknown as FetchLike,
      ),
    /network down/,
  );

  assert.equal(getRate(db, "anyone", "USD", "CNY"), before, "失败绝不删除已有汇率");
});
