import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "../db/client.js";
import { exchangeRates } from "../db/schema.js";
import { badRequest } from "./errors.js";

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

// ---------- 币种字段校验与跨币种护栏 ----------

// 统一的币种字段：ISO-4217 三字母代码（大小写不敏感，统一归一为大写后落库）。
// 历史缺陷：accounts/transactions/loans 的 currency 都曾是裸 z.string()，
// 可以写入 "hello" 这类值，而统计侧对未知币种按 1:1 兜底，会静默算错金额。
export const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "币种需为 3 位字母代码（如 CNY、USD）")
  .transform((s) => s.toUpperCase());

// 币种归一（读侧兜底）：兼容历史上以 "usd" 等小写形式写入的存量数据，
// 使汇率查表能把它们当作 USD 处理，而不是落到"未知币种 1:1"分支。
function normalize(code: string | null | undefined): string {
  return (code ?? "").trim().toUpperCase();
}

export function getRate(db: DB, userId: string, currency: string, base: string): number {
  const cur = normalize(currency);
  const b = normalize(base);
  if (cur === b) return 1;
  // 用户级汇率
  const userRow = db
    .select()
    .from(exchangeRates)
    .where(and(eq(exchangeRates.userId, userId), eq(exchangeRates.baseCurrency, b), eq(exchangeRates.currency, cur)))
    .get();
  if (userRow) return userRow.rate;
  // 全局汇率
  const globalRow = db
    .select()
    .from(exchangeRates)
    .where(and(isNull(exchangeRates.userId), eq(exchangeRates.baseCurrency, b), eq(exchangeRates.currency, cur)))
    .get();
  if (globalRow) return globalRow.rate;
  // 内置兜底（人民币视角）
  const fallback = BUILTIN_RATES[cur];
  if (fallback) return fallback;
  // 未知币种：按 1:1 兜底，绝不崩溃
  return 1;
}

// amount（foreign currency）→ 等值 base 币种金额（四舍五入到整数分）
export function convert(db: DB, userId: string, amount: number, from: string, to: string): number {
  if (!from || normalize(from) === normalize(to)) return amount;
  return Math.round(amount * getRate(db, userId, from, to));
}

// 跨币种护栏：本项目尚未实现交易级汇率换算，因此任何"把某币种金额记到另一币种账户"
// 的写入都必须在写库前拒绝，否则会出现账实不符（金额按账户币种被重新解释）。
// 所有写路径（创建/修改/导入/暂存/提交）统一走这里，避免再出现"创建时校验、PATCH 绕过"的漏洞。
export interface CurrencyCandidate {
  currency: string;
  /** 仅用于错误信息，便于定位是哪个账户 */
  name?: string | null;
}

export function assertCurrencyCompatible(account: CurrencyCandidate, currency: string): void {
  if (normalize(account.currency) !== normalize(currency)) {
    const who = account.name ? `账户「${account.name}」` : "目标账户";
    throw badRequest(
      "CURRENCY_MISMATCH",
      `跨币种操作暂不支持：${who}币种为 ${normalize(account.currency)}，流水币种为 ${normalize(currency)}。` +
        "请改用同币种账户。",
    );
  }
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