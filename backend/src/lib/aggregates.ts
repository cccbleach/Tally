import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { categories, transactions } from "../db/schema.js";
import { currentYearMonth, daysInMonth, todayStr } from "./date.js";

// 累计结余：该账本历史所有收入 − 所有支出（不依赖账户；全站人民币，直接相加）。
// 账户域下线后这是「我现在有多少钱」的唯一口径（前提是期初余额为 0，生产即如此）。
export function ledgerCumulativeNet(db: DB, ledgerId: string): number {
  const rows = db.all(sql`
    SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS net
    FROM transactions
    WHERE ledger_id = ${ledgerId}
  `) as { net: number }[];
  return rows[0]?.net ?? 0;
}

export function monthRange(year: number, month: number): { from: string; to: string } {
  const m = String(month).padStart(2, "0");
  const from = year + "-" + m + "-01";
  const to = year + "-" + m + "-" + String(daysInMonth(year, month)).padStart(2, "0");
  return { from, to };
}

export interface MonthlyTotals { income: number; expense: number; }

export function monthlyTotals(db: DB, ledgerId: string, year: number, month: number): MonthlyTotals {
  const { from, to } = monthRange(year, month);
  const rows = txRowsInRange(db, ledgerId, from, to);
  let income = 0;
  let expense = 0;
  for (const t of rows) {
    if (t.type === "income") income += t.amount;
    else if (t.type === "expense") expense += t.amount;
  }
  return { income, expense };
}

export interface CategoryAgg { categoryId: string | null; name: string; icon: string | null; color: string | null; amount: number; }

export function expenseByCategory(db: DB, ledgerId: string, year: number, month: number): CategoryAgg[] {
  const { from, to } = monthRange(year, month);
  const rows = txRowsInRange(db, ledgerId, from, to).filter((t) => t.type === "expense");
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
    cur.amount += t.amount;
    acc.set(key, cur);
  }
  return [...acc.values()].sort((a, b) => b.amount - a.amount).map((x) => x);
}

export interface DailyAgg { date: string; income: number; expense: number; }

export function dailyTotals(db: DB, ledgerId: string, year: number, month: number): DailyAgg[] {
  const { from, to } = monthRange(year, month);
  const rows = txRowsInRange(db, ledgerId, from, to);
  const acc = new Map<string, DailyAgg>();
  for (const t of rows) {
    const cur = acc.get(t.date) ?? { date: t.date, income: 0, expense: 0 };
    if (t.type === "income") cur.income += t.amount;
    else if (t.type === "expense") cur.expense += t.amount;
    acc.set(t.date, cur);
  }
  return [...acc.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface TrendPoint { year: number; month: number; income: number; expense: number; }

export function trend(db: DB, ledgerId: string, months: number): TrendPoint[] {
  const n = Math.max(1, Math.min(60, months));
  const { year: curYear, month: curMonth } = currentYearMonth();
  const curIndex = curYear * 12 + (curMonth - 1);
  const startIndex = curIndex - (n - 1);
  const from = startIndexToDateStr(startIndex);
  const to = todayStr();
  const rows = txRowsInRange(db, ledgerId, from, to);
  const acc = new Map<string, { income: number; expense: number }>();
  for (const t of rows) {
    const ym = t.date.slice(0, 7);
    const cur = acc.get(ym) ?? { income: 0, expense: 0 };
    if (t.type === "income") cur.income += t.amount;
    else if (t.type === "expense") cur.expense += t.amount;
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

function txRowsInRange(db: DB, ledgerId: string, from: string, to: string) {
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
