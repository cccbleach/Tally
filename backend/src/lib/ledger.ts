import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DB } from "../db/client.js";
import { ledgers, users } from "../db/schema.js";

// 为用户创建默认账本并写回 user.default_ledger_id。
export function createDefaultLedger(db: DB, userId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(ledgers)
    .values({ id, userId, name: "默认账本", currency: "CNY", isDefault: true, createdAt: now, updatedAt: now })
    .run();
  db.update(users).set({ defaultLedgerId: id, updatedAt: now }).where(eq(users.id, userId)).run();
  return id;
}

// 获取用户当前账本（默认账本）。为兼容旧数据，缺失时懒创建。
export function getLedgerId(db: DB, userId: string): string {
  const u = db.select().from(users).where(eq(users.id, userId)).get();
  if (u?.defaultLedgerId) return u.defaultLedgerId;
  return createDefaultLedger(db, userId);
}
