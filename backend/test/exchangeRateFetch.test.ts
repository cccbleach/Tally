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

test("基准不一致时把汇率归一化到部署基准（避免回退到人民币视角内置表而静默算错）", async () => {
  // 已复现的缺陷：源按 CNY 报价（默认 URL 就是 CNY 基准），而部署 BASE_CURRENCY=USD 时，
  // 抓取若按源的基准写库，查表永久落空 → 回退内置兜底表（人民币视角）→ 实测偏差约 7.7 倍。
  const res = await fetchAndStoreGlobalRates(
    db,
    "https://rates.example/latest",
    payloadFetch({ result: "success", base_code: "CNY", rates: { USD: 0.1389, JPY: 21.5, CNY: 1 } }),
    "USD",
  );
  assert.equal(res.base, "USD", "写入的基准必须是部署基准");
  assert.equal(res.stored, 2, "应写入 JPY 与被补回的源基准 CNY（目标基准自身除外）");
  // 1 USD = 21.5 / 0.1389 ≈ 154.79 JPY；CNY 侧为 21.5
  assert.ok(Math.abs(getRate(db, "u", "JPY", "USD") - 154.788) < 0.01, "JPY 应按 USD 基准折算");
  assert.ok(Math.abs(getRate(db, "u", "CNY", "USD") - 1 / 0.1389) < 0.001, "源基准 CNY 必须补回并按目标基准折算（否则回退内置表 CNY=1，偏差 7.2 倍）");
  assert.equal(getRate(db, "u", "USD", "USD"), 1, "基准币自身恒为 1");

  // 关键回归：不能再回退到内置的 CNY 视角值（0.05 是 CNY/JPY，被当成 USD/JPY 用）
  assert.notEqual(getRate(db, "u", "JPY", "USD"), 0.05, "不得回退到人民币视角的内置兜底值");
});

test("源基准与部署基准不一致且无法换算时：明确报错且不写入任何汇率", async () => {
  // 响应里没有部署基准（USD）的汇率 → 无法交叉换算，必须拒绝而不是按对方基准写错
  await assert.rejects(
    () =>
      fetchAndStoreGlobalRates(
        db,
        "https://rates.example/latest",
        payloadFetch({ result: "success", base_code: "CNY", rates: { JPY: 21.5, EUR: 0.127 } }),
        "USD",
      ),
    /与部署基准 USD 不一致/,
  );
  // 调度层包装后只记日志、不抛错
  const ok = await runExchangeRateFetchSafely(
    db,
    "https://rates.example/latest",
    payloadFetch({ result: "success", base_code: "CNY", rates: { JPY: 21.5 } }),
    "USD",
  );
  assert.equal(ok, false, "失败应返回 false（由调度层记日志）");
});
