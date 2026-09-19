import { and, eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { familyMembers, ledgers } from "../db/schema.js";
import { forbidden } from "./errors.js";

// 统一权限服务（单家庭模型）：
// 财务资源属于账本，用户是操作者。ledgerId 用于权限，userId 用于审计。
// 角色矩阵（家庭仅保留 owner/member 两种角色）：
//   Owner : 查看/创建/修改任意流水/管理分类/管理成员/转移所有权/删除家庭
//   Member: 查看/创建/修改本人流水/管理分类（共同读写）
// admin/viewer 为旧多角色兼容映射（线上不会再产生）。
export type FamilyRole = "owner" | "admin" | "member" | "viewer";

export type LedgerPermission =
  | "ledger:view"
  | "transaction:create"
  | "transaction:update"
  | "transaction:update_any"
  | "category:manage"
  | "member:manage"
  | "ownership:transfer";

const LEDGER_PERMISSIONS: Record<FamilyRole, ReadonlySet<LedgerPermission>> = {
  owner: new Set([
    "ledger:view",
    "transaction:create",
    "transaction:update",
    "transaction:update_any",
    "category:manage",
    "member:manage",
    "ownership:transfer",
  ]),
  admin: new Set([
    "ledger:view",
    "transaction:create",
    "transaction:update",
    "transaction:update_any",
    "category:manage",
    "member:manage",
  ]),
  member: new Set([
    "ledger:view",
    "transaction:create",
    "transaction:update",
    "category:manage",
  ]),
  viewer: new Set(["ledger:view"]),
};

export function roleHasLedgerPermission(role: FamilyRole | undefined, permission: LedgerPermission): boolean {
  if (!role) return false;
  return (LEDGER_PERMISSIONS[role] ?? new Set<LedgerPermission>()).has(permission);
}

// 查询用户在某个账本中的角色：
// - 个人账本：仅归属用户本人，视为 full 权限（owner）
// - 家庭账本：取 family_members 角色
export function ledgerRoleFor(db: DB, userId: string, ledgerId: string): { role: FamilyRole | "personal"; familyId: string | null } | null {
  const ledger = db.select().from(ledgers).where(eq(ledgers.id, ledgerId)).get();
  if (!ledger) return null;
  // 已删除账本（家庭删除后保留数据但不可访问）对任何角色都不可用
  if (ledger.deletedAt) return null;
  if (!ledger.familyId) {
    return ledger.userId === userId ? { role: "personal", familyId: null } : null;
  }
  const member = db
    .select()
    .from(familyMembers)
    .where(
      and(
        eq(familyMembers.familyId, ledger.familyId),
        eq(familyMembers.userId, userId),
        eq(familyMembers.isActive, true),
      ),
    )
    .get();
  if (!member) return null;
  return { role: member.role as FamilyRole, familyId: ledger.familyId };
}

// 统一入口：校验用户对账本拥有某权限，否则抛 403。
export function requireLedgerPermission(db: DB, userId: string, ledgerId: string, permission: LedgerPermission): void {
  const info = ledgerRoleFor(db, userId, ledgerId);
  if (!info) throw forbidden("LEDGER_FORBIDDEN", "无权访问该账本");
  // 个人账本归属用户本人，默认拥有全部权限
  if (info.role === "personal") {
    if (permission === "ledger:view") return;
    // 个人账本全权限
    return;
  }
  if (!roleHasLedgerPermission(info.role, permission)) {
    throw forbidden("PERMISSION_DENIED", `没有该操作权限（${permission}）`);
  }
}

// 流水修改（PATCH/DELETE）校验：把“账本可访问”与“资源可修改”分开。
// - 个人账本：本人全权限
// - Owner/Admin：可修改任意成员流水（transaction:update_any）
// - Member：只可修改/删除本人创建（transaction:update + resourceOwnerUserId === 当前用户）
// - Viewer：不可修改
// 防止普通 member 修改其他成员创建的流水。
export function requireTransactionModify(
  db: DB,
  userId: string,
  ledgerId: string,
  resourceOwnerUserId: string,
): void {
  const info = ledgerRoleFor(db, userId, ledgerId);
  if (!info) throw forbidden("LEDGER_FORBIDDEN", "无权访问该账本");
  if (info.role === "personal") return;
  if (info.role === "owner" || info.role === "admin") {
    if (!roleHasLedgerPermission(info.role, "transaction:update_any")) {
      throw forbidden("PERMISSION_DENIED", `没有该操作权限（transaction:update_any）`);
    }
    return;
  }
  if (!roleHasLedgerPermission(info.role, "transaction:update")) {
    throw forbidden("PERMISSION_DENIED", "没有该操作权限");
  }
  if (resourceOwnerUserId !== userId) {
    throw forbidden("PERMISSION_DENIED", "普通成员只能修改或删除自己创建的流水");
  }
}
