process.env.ALIYUN_SMS_ENABLED = "false";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dateStrInTimeZone, todayStr, currentYearMonth } from "../src/lib/date.js";

test("同一时刻不同时区的日期口径正确（确定用例）", () => {
  // UTC 2024-01-01 00:30 → 北京已是 1/1 08:30，纽约还是 12/31 19:30（前一自然日）
  assert.equal(dateStrInTimeZone("UTC", new Date("2024-01-01T00:30:00Z")), "2024-01-01");
  assert.equal(dateStrInTimeZone("Asia/Shanghai", new Date("2024-01-01T00:30:00Z")), "2024-01-01");
  assert.equal(dateStrInTimeZone("America/New_York", new Date("2024-01-01T00:30:00Z")), "2023-12-31");
});

test("todayStr 与 currentYearMonth 来自同一业务时区口径", () => {
  const s = todayStr();
  const { year, month } = currentYearMonth();
  const [y, m] = s.split("-").map(Number);
  assert.equal(y, year);
  assert.equal(m, month);
});

test("无效时区回退到服务器本地而不是崩溃", () => {
  const s = dateStrInTimeZone("Not/A_Real_Zone", new Date("2024-06-01T12:00:00Z"));
  assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
});
