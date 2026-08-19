import { and, eq, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DB } from "../db/client.js";
import { accounts, recurring, transactions } from "../db/schema.js";
import { addDays, addMonths, addYears, todayStr } from "./date.js";

function advance(date: string, frequency: string, interval: number): string {
  switch (frequency) {
    case "daily":
      return addDays(date, interval);
    case "weekly":
      return addDays(date, interval * 7);
    case "monthly":
      return addMonths(date, interval);
    case "yearly":
      return addYears(date, interval);
    default:
      return addDays(date, interval);
  }
}

// 生成所有到期（nextRunDate <= 今天）的周期账单对应流水。
// 幂等：以 (recurring_id, date) 唯一约束 + onConflictDoNothing 保证，
// 并在单个数据库事务内完成全部生成与状态推进，崩溃/并发不会重复入账。
export function runDueRecurring(db: DB): number {
  const today = todayStr();
  const due = db
    .select()
    .from(recurring)
    .where(and(eq(recurring.isActive, true), lte(recurring.nextRunDate, today)))
    .all();
  const now = new Date().toISOString();

  const accountIds = [...new Set(due.map((r) => r.accountId))];
  const currencyByAccount = new Map<string, string>();
  for (const id of accountIds) {
    const a = db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (a) currencyByAccount.set(a.id, a.currency);
  }

  return db.transaction((tx) => {
    let generated = 0;
    for (const r of due) {
      let cursor = r.nextRunDate;
      let ended = false;
      while (cursor <= today) {
        if (r.endDate && cursor > r.endDate) {
          ended = true;
          break;
        }
        const currency = currencyByAccount.get(r.accountId) ?? "CNY";
        const result = tx
          .insert(transactions)
          .values({
            id: randomUUID(),
            userId: r.userId,
            ledgerId: r.ledgerId ?? null,
            accountId: r.accountId,
            categoryId: r.categoryId,
            type: r.type,
            amount: r.amount,
            currency, // 继承账户币种，避免多币种下硬编码 CNY 算错
            note: r.note ?? null,
            date: cursor,
            transferToAccountId: null,
            recurringId: r.id,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: [transactions.recurringId, transactions.date] })
          .run();
        if (result.changes > 0) generated++;
        cursor = advance(cursor, r.frequency, r.interval);
      }
      tx.update(recurring)
        .set({ nextRunDate: cursor, lastGeneratedDate: today, isActive: ended ? false : true, updatedAt: now })
        .where(eq(recurring.id, r.id))
        .run();
    }
    return generated;
  });
}
