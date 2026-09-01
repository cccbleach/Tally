import { and, eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { familyMembers, ledgers, users, type LedgerRow } from "../db/schema.js";
import { forbidden, notFound } from "./errors.js";

// 获取用户可访问的账本：
// - 不传 ledgerId：优先 current_ledger_id，其次 default_ledger_id
// - 传 ledgerId：校验个人账本归属或家庭账本成员身份
export function getAccessibleLedger(db: DB, userId: string, ledgerId?: string): LedgerRow {
  let targetId = ledgerId;
  if (!targetId) {
    const u = db.select().from(users).where(eq(users.id, userId)).get();
    targetId = u?.currentLedgerId ?? u?.defaultLedgerId ?? undefined;
  }
  if (!targetId) throw notFound("LEDGER_NOT_FOUND", "账本不存在");
  const ledger = db.select().from(ledgers).where(eq(ledgers.id, targetId)).get();
  if (!ledger) throw notFound("LEDGER_NOT_FOUND", "账本不存在");

  // 已删除（家庭删除后保留数据但不可访问）的账本对任何人（含原属主）不可访问
  if (ledger.deletedAt) throw notFound("LEDGER_DELETED", "账本已删除，无法访问");

  if (ledger.familyId) {
    const member = db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.familyId, ledger.familyId), eq(familyMembers.userId, userId), eq(familyMembers.isActive, true)))
      .get();
    if (!member) throw forbidden("LEDGER_FORBIDDEN", "无权访问该共享账本");
  } else {
    if (ledger.userId !== userId) throw forbidden("LEDGER_FORBIDDEN", "无权访问该账本");
  }
  return ledger;
}

export function isFamilyMember(db: DB, userId: string, familyId: string): boolean {
  return !!db
    .select()
    .from(familyMembers)
    .where(and(eq(familyMembers.familyId, familyId), eq(familyMembers.userId, userId), eq(familyMembers.isActive, true)))
    .get();
}
