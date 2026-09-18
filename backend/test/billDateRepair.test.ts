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
