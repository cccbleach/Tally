import { and, eq, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DB } from "../db/client.js";
import { recurring, transactions } from "../db/schema.js";
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
        const result = tx
          .insert(transactions)
          .values({
            id: randomUUID(),
            userId: r.userId,
            ledgerId: r.ledgerId ?? null,
            categoryId: r.categoryId,
            type: r.type,
            amount: r.amount,
            note: r.note ?? null,
            date: cursor,
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
