import { and, eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { accounts, type AccountRow } from "../db/schema.js";

// 账户数据访问层：按账本访问（访问控制已在路由层用 getAccessibleLedger 校验）。
export function listAccountsForUser(db: DB, _userId: string, ledgerId: string): AccountRow[] {
  return db
    .select()
    .from(accounts)
    .where(eq(accounts.ledgerId, ledgerId))
    .all();
}

export function accountNameMap(db: DB, userId: string, ledgerId: string): Map<string, string> {
  const rows = listAccountsForUser(db, userId, ledgerId);
  return new Map(rows.map((a) => [a.id, a.name]));
}

export function accountById(db: DB, _userId: string, ledgerId: string, id: string): AccountRow | undefined {
  return db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.ledgerId, ledgerId)))
    .get();
}
