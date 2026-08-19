import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DB } from "../db/client.js";
import { exchangeRates } from "../db/schema.js";
import { config } from "../config.js";

// 全局兜底汇率（人民币视角，大致数值，仅用于未配置汇率时避免直接相加算错）。
const BUILTIN_RATES: Record<string, number> = {
  CNY: 1,
  USD: 7.2,
  EUR: 7.8,
  GBP: 9.1,
  JPY: 0.05,
  HKD: 0.92,
  KRW: 0.0054,
  SGD: 5.3,
  AUD: 4.7,
  CAD: 5.2,
};

export function getRate(db: DB, userId: string, currency: string, base: string): number {
  if (currency === base) return 1;
  // 用户级汇率
  const userRow = db
    .select()
    .from(exchangeRates)
    .where(and(eq(exchangeRates.userId, userId), eq(exchangeRates.baseCurrency, base), eq(exchangeRates.currency, currency)))
    .get();
  if (userRow) return userRow.rate;
  // 全局汇率
  const globalRow = db
    .select()
    .from(exchangeRates)
    .where(and(isNull(exchangeRates.userId), eq(exchangeRates.baseCurrency, base), eq(exchangeRates.currency, currency)))
    .get();
  if (globalRow) return globalRow.rate;
  // 内置兜底（人民币视角）
  const fallback = BUILTIN_RATES[currency];
  if (fallback) return fallback;
  // 未知币种：按 1:1 兜底，绝不崩溃
  return 1;
}

// amount（foreign currency）→ 等值 base 币种金额（四舍五入到整数分）
export function convert(db: DB, userId: string, amount: number, from: string, to: string): number {
  if (!from || from === to) return amount;
  return Math.round(amount * getRate(db, userId, from, to));
}

// 写入/更新一条汇率（upsert），供未来管理接口调用
export function setRate(db: DB, userId: string | null, base: string, currency: string, rate: number): void {
  const now = new Date().toISOString();
  const cond = userId
    ? and(eq(exchangeRates.userId, userId), eq(exchangeRates.baseCurrency, base), eq(exchangeRates.currency, currency))
    : and(isNull(exchangeRates.userId), eq(exchangeRates.baseCurrency, base), eq(exchangeRates.currency, currency));
  const existing = db.select().from(exchangeRates).where(cond).get();
  if (existing) {
    db.update(exchangeRates).set({ rate, createdAt: now }).where(eq(exchangeRates.id, existing.id)).run();
    return;
  }
  db.insert(exchangeRates)
    .values({ id: randomUUID(), userId, baseCurrency: base, currency, rate, createdAt: now })
    .run();
}