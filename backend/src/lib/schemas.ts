import { z } from "zod";
import { badRequest } from "./errors.js";
import { isValidDateStr, isValidYearMonth } from "./date.js";

// 日期/月份的 strict 校验入口：形状正则挡不住「不存在的日期」与「13 月」，
// 一旦放过去就会被 parseDateStr 的 new Date(y, m-1, d) 静默滚动（2026-02-31 → 2026-03-03），
// 还款日、流水归属月份都会跟着错位。写入路径统一用这里的 schema。
const DATE_MSG = "日期不存在：请检查月份天数（例如 2 月没有 31 日）";

export function dateStr(msg: string = DATE_MSG) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD")
    .refine(isValidDateStr, msg);
}

export function yearMonthStr(msg = "月份格式应为 YYYY-MM 且月份在 01-12 之间") {
  return z
    .string()
    .regex(/^\d{4}-\d{2}$/, msg)
    .refine(isValidYearMonth, msg);
}

export interface YearMonthQuery {
  year: number;
  month: number;
}

// 查询参数里的 year/month：非法值直接 400。
// 历史行为是 `Number(q.month) || cur.month`，于是 ?month=13 会 200 返回一份空统计
// （month 字段还照抄 13），客户端展示"这个月没有数据"而不是参数错误。
export function parseYearMonthQuery(
  q: Record<string, string | undefined>,
  cur: YearMonthQuery,
): YearMonthQuery {
  const year = q.year === undefined || q.year === "" ? cur.year : Number(q.year);
  const month = q.month === undefined || q.month === "" ? cur.month : Number(q.month);
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw badRequest("INVALID_YEAR", "year 必须是 1970-9999 之间的整数");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw badRequest("INVALID_MONTH", "month 必须是 1-12 之间的整数");
  }
  return { year, month };
}
