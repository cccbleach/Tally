// 回归：坏日期修复脚本的判定逻辑（scripts/repair-bill-dates.mjs）。
// 这是会**写生产财务数据**的脚本，判定必须锁死：能精确修复的才修，自相矛盾/无法识别的绝不猜。
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error 脚本是 .mjs，无类型声明；这里只测纯函数
import { parseBrokenDate, inferDate, embeddedDate } from "../../scripts/repair-bill-dates.mjs";

test("坏日期文本解析：只认「<Weekday> <Mon> <D>」，其它一律返回 null", () => {
  assert.deepEqual(parseBrokenDate("Tue Aug 18"), { weekday: 2, month: 8, day: 18 });
  assert.deepEqual(parseBrokenDate("  Wed May 20 "), { weekday: 3, month: 5, day: 20 });
  assert.equal(parseBrokenDate("2026-08-18"), null);
  assert.equal(parseBrokenDate("Tue 8月 18"), null);
  assert.equal(parseBrokenDate("?? ??"), null);
  assert.equal(parseBrokenDate(""), null);
});

test("年份锚定在 [导入年-1, 导入年] 内，不唯一就拒绝（星期+月日在多年份会重复）", () => {
  // "Tue Aug 18" 在 2009/2015/2020/2026 都是周二 —— 必须靠导入时间收窄窗口
  const parsed = parseBrokenDate("Tue Aug 18")!;
  assert.deepEqual(inferDate(parsed, 2026, "2026-09-16"), { iso: "2026-08-18" });
  // 导入时间早于该日期 → 不可能，拒绝
  assert.ok(inferDate(parsed, 2026, "2026-08-01").error, "不得推断出晚于导入时间的日期");
  // 窗口内没有星期吻合的年份 → 拒绝而不是硬猜
  assert.ok(inferDate(parseBrokenDate("Mon Feb 30") ?? { weekday: 1, month: 2, day: 30 }, 2026, "2026-09-16").error);
});

test("单号内嵌日期（微信交易单号含 YYYYMMDD）可作精确证据，且必须与文本星期自洽", () => {
  assert.deepEqual(embeddedDate("4500000340202608182475929140"), ["2026-08-18"]);
  assert.deepEqual(embeddedDate(null), []);
  // 非法月日不会被当成日期
  assert.deepEqual(embeddedDate("4500000340202613400000000000"), []);
});

test("时区回卷：文本日期比真实日期晚一天时必须接受（+08 渲染跨午夜），真矛盾才拒绝", async () => {
  const { pickAuthoritativeDate } = await import("../../scripts/repair-bill-dates.mjs");
  const TUE = 2;
  // 线上实测：文本 "Tue Aug 18" 对应真实 2026-08-17（周一）—— 必须接受
  assert.deepEqual(pickAuthoritativeDate(["2026-08-17"], TUE), { iso: "2026-08-17" });
  // 同一天（16:00 前的交易不会跨午夜）也必须接受
  assert.deepEqual(pickAuthoritativeDate(["2026-08-18"], TUE), { iso: "2026-08-18" });
  // 真的矛盾（相差 2 天）→ 拒绝，绝不猜
  assert.ok(pickAuthoritativeDate(["2026-01-01"], TUE).error);
  // 多个候选 → 拒绝
  assert.ok(pickAuthoritativeDate(["2026-08-17", "2026-08-18"], TUE).error);
  // 商户单号里的伪日期（2000-03-21）必须被年份窗口过滤掉，只留真实候选
  assert.deepEqual(
    pickAuthoritativeDate(["2000-03-21", "2026-08-04"], TUE, { minYear: 2025, maxYear: 2026 }),
    { iso: "2026-08-04" },
    "商户单号随机数字凑出的假日期必须被年份窗口排除",
  );
  assert.ok(
    pickAuthoritativeDate(["2000-03-21"], TUE, { minYear: 2025, maxYear: 2026 }).error,
    "窗口外的候选全部排除后应拒绝",
  );
});
