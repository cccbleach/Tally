import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { accounts, categories, transactions } from "../db/schema.js";
import { currentYearMonth, daysInMonth, todayStr } from "./date.js";
import { convert } from "./currency.js";
import { config } from "../config.js";

export interface BalanceRow { accountId: string; balance: number; }

// 账户余额（账户本币口径）= 初始余额 + 收入 - 支出 + 转入 - 转出（转账不计入收支）。
// 每个账户按其自身币种核算，不做跨币种换算。
export function computeAccountBalances(db: DB, _userId: string, ledgerId: string): Map<string, number> {
  const rows = db.all(sql`
    SELECT a.id AS accountId,
      a.initial_balance
        + COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id = a.id AND t.type = 'income'), 0)
        - COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id = a.id AND t.type = 'expense'), 0)
        + COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.transfer_to_account_id = a.id AND t.type = 'transfer'), 0)
        - COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id = a.id AND t.type = 'transfer'), 0) AS balance
    FROM accounts a
    WHERE a.ledger_id = ${ledgerId}
  `) as BalanceRow[];
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.accountId, r.balance);
  return map;
}

export interface NetAssetsSummary { assets: number; net: number; }

// 账户净值（基准币）：非归档账户余额之和，借/贷已无负债域后的唯一口径。
// 历史版本还返回 debts（信用卡欠款 + 贷款剩余本金），负债功能下线后一并移除。
export function netAssetsSummary(db: DB, userId: string, ledgerId: string): NetAssetsSummary {
  const balances = computeAccountBalances(db, userId, ledgerId);
  const accts = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.ledgerId, ledgerId), eq(accounts.isArchived, false)))
    .all();
  let assets = 0;
  for (const a of accts) {
    const native = balances.get(a.id) ?? a.initialBalance;
    assets += convert(db, userId, native, a.currency, config.baseCurrency);
  }
  return { assets, net: assets };
}

export function monthRange(year: number, month: number): { from: string; to: string } {
  const m = String(month).padStart(2, "0");
  const from = year + "-" + m + "-01";
  const to = year + "-" + m + "-" + String(daysInMonth(year, month)).padStart(2, "0");
  return { from, to };
}

export interface MonthlyTotals { income: number; expense: number; }

export function monthlyTotals(db: DB, userId: string, ledgerId: string, year: number, month: number): MonthlyTotals {
  const { from, to } = monthRange(year, month);
  const rows = txRowsInRange(db, userId, ledgerId, from, to);
  let income = 0;
  let expense = 0;
  for (const t of rows) {
    if (t.type === "income") income += convert(db, userId, t.amount, t.currency, config.baseCurrency);
    else if (t.type === "expense") expense += convert(db, userId, t.amount, t.currency, config.baseCurrency);
  }
  return { income, expense };
}

export interface CategoryAgg { categoryId: string | null; name: string; icon: string | null; color: string | null; amount: number; }

export function expenseByCategory(db: DB, userId: string, ledgerId: string, year: number, month: number): CategoryAgg[] {
  const { from, to } = monthRange(year, month);
  const rows = txRowsInRange(db, userId, ledgerId, from, to).filter((t) => t.type === "expense");
  const cats = db
    .select()
    .from(categories)
    .where(eq(categories.ledgerId, ledgerId))
    .all();
  const catInfo = new Map(cats.map((c) => [c.id, c]));

  const acc = new Map<string | null, CategoryAgg>();
  for (const t of rows) {
    const key = t.categoryId;
    const cur = acc.get(key) ?? { categoryId: key, name: "", icon: null, color: null, amount: 0 };
    const cat = key ? catInfo.get(key) : undefined;
    cur.name = cat?.name ?? "未分类";
    cur.icon = cat?.icon ?? null;
    cur.color = cat?.color ?? null;
    cur.amount += convert(db, userId, t.amount, t.currency, config.baseCurrency);
    acc.set(key, cur);
  }
  return [...acc.values()].sort((a, b) => b.amount - a.amount).map((x) => x);
}

export interface AccountAgg { accountId: string; name: string; amount: number; }

export function expenseByAccount(db: DB, userId: string, ledgerId: string, year: number, month: number): AccountAgg[] {
  const { from, to } = monthRange(year, month);
  const rows = txRowsInRange(db, userId, ledgerId, from, to).filter((t) => t.type === "expense");
  const accts = db
    .select()
    .from(accounts)
    .where(eq(accounts.ledgerId, ledgerId))
    .all();
  const nameMap = new Map(accts.map((a) => [a.id, a.name]));
  const acc = new Map<string, AccountAgg>();
  for (const t of rows) {
    const cur = acc.get(t.accountId) ?? { accountId: t.accountId, name: nameMap.get(t.accountId) ?? "未知", amount: 0 };
    cur.amount += convert(db, userId, t.amount, t.currency, config.baseCurrency);
    acc.set(t.accountId, cur);
  }
  return [...acc.values()].sort((a, b) => b.amount - a.amount);
}

export interface DailyAgg { date: string; income: number; expense: number; }

export function dailyTotals(db: DB, userId: string, ledgerId: string, year: number, month: number): DailyAgg[] {
  const { from, to } = monthRange(year, month);
  const rows = txRowsInRange(db, userId, ledgerId, from, to);
  const acc = new Map<string, DailyAgg>();
  for (const t of rows) {
    const cur = acc.get(t.date) ?? { date: t.date, income: 0, expense: 0 };
    if (t.type === "income") cur.income += convert(db, userId, t.amount, t.currency, config.baseCurrency);
    else if (t.type === "expense") cur.expense += convert(db, userId, t.amount, t.currency, config.baseCurrency);
    acc.set(t.date, cur);
  }
  return [...acc.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface TrendPoint { year: number; month: number; income: number; expense: number; }

export function trend(db: DB, userId: string, ledgerId: string, months: number): TrendPoint[] {
  const n = Math.max(1, Math.min(60, months));
  const { year: curYear, month: curMonth } = currentYearMonth();
  const curIndex = curYear * 12 + (curMonth - 1);
  const startIndex = curIndex - (n - 1);
  const from = startIndexToDateStr(startIndex);
  const to = todayStr();
  const rows = txRowsInRange(db, userId, ledgerId, from, to);
  const acc = new Map<string, { income: number; expense: number }>();
  for (const t of rows) {
    const ym = t.date.slice(0, 7);
    const cur = acc.get(ym) ?? { income: 0, expense: 0 };
    if (t.type === "income") cur.income += convert(db, userId, t.amount, t.currency, config.baseCurrency);
    else if (t.type === "expense") cur.expense += convert(db, userId, t.amount, t.currency, config.baseCurrency);
    acc.set(ym, cur);
  }
  const out: TrendPoint[] = [];
  for (let i = 0; i < n; i++) {
    const idx = startIndex + i;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    const ym = y + "-" + String(m).padStart(2, "0");
    const r = acc.get(ym);
    out.push({ year: y, month: m, income: r?.income ?? 0, expense: r?.expense ?? 0 });
  }
  return out;
}

function startIndexToDateStr(index: number): string {
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return y + "-" + String(m).padStart(2, "0") + "-01";
}

function txRowsInRange(db: DB, _userId: string, ledgerId: string, from: string, to: string) {
  return db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .all();
}
