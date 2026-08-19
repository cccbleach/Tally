// 日期统一用 YYYY-MM-DD 字符串。业务时区（config.timezone）显式配置，
// “今天/当月”以该时区计算，避免 Docker(UTC) 与国内用户不一致。

import { config } from "../config.js";

const DEFAULT_ZONE = "Asia/Shanghai";

export function todayStr(tz?: string): string {
  if (tz) return dateStrInTimeZone(tz, new Date());
  return dateStrInTimeZone(config.timezone || DEFAULT_ZONE, new Date());
}

export function dateStrInTimeZone(tz: string, d: Date): string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // 时区标识无效等极端情况回退到服务器本地时间
    fmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return get("year") + "-" + get("month") + "-" + get("day");
}

export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

export function parseDateStr(s: string): Date {
  const [y, m, d] = s.split("-").map((x) => Number(x));
  return new Date(y as number, (m as number) - 1, d as number);
}

// 日期字符串比较（词法序即时间序，YYYY-MM-DD 格式保证）
export function dateStrCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addDays(s: string, days: number): string {
  const d = parseDateStr(s);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

export function addMonths(s: string, months: number): string {
  const d = parseDateStr(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  // 月末溢出时钳制到当月最后一天
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toDateStr(d);
}

export function addYears(s: string, years: number): string {
  const d = parseDateStr(s);
  const day = d.getDate();
  d.setDate(1);
  d.setFullYear(d.getFullYear() + years);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toDateStr(d);
}

export function currentYearMonth(): { year: number; month: number } {
  const s = todayStr();
  const [y, m] = s.split("-").map(Number);
  return { year: y as number, month: m as number };
}

// 计算某月天数
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}
