import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { families, familyMembers, familyInvitations, ledgers, users } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { getAccessibleLedger } from "../lib/access.js";
import { writeAudit } from "../lib/audit.js";
import { seedDefaultCategories } from "../db/seed.js";
import { nicknameKey, validateNickname } from "../lib/nickname.js";
import type { Jwt } from "../auth/jwt.js";

type Role = "owner" | "member";
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 邀请 7 天有效

const createFamilySchema = z.object({
  name: z.string().min(1, "共享账本名称不能为空").max(40, "共享账本名称过长"),
});

const inviteSchema = z.object({
  nickname: z.string().min(1, "昵称不能为空").max(40, "昵称过长"),
});

const patchFamilySchema = z.object({
  name: z.string().min(1).max(40).optional(),
});

const transferSchema = z.object({
  memberUserId: z.string().min(1, "成员不能为空"),
});

const switchLedgerSchema = z.object({
  ledgerId: z.string().min(1, "账本不能为空"),
});

function familyDto(f: typeof families.$inferSelect) {
  return { id: f.id, name: f.name, ownerUserId: f.ownerUserId, createdAt: f.createdAt, updatedAt: f.updatedAt };
}

// 判断一次 SQLite 写冲突是否精确命中「每个账号最多属于一个 active 家庭」的唯一索引
// （uniq_family_single_active：family_members(user_id) WHERE is_active=1）。
// 必须只识别该唯一索引：审计触发器（SQLITE_CONSTRAINT_TRIGGER）、外键（FOREIGNKEY）、
// NOT NULL、CHECK 等约束不得被误报为 ALREADY_IN_FAMILY。
//
// SQLite 对 uniq_family_single_active 的报错为：
//   SQLITE_CONSTRAINT_UNIQUE / "UNIQUE constraint failed: family_members.user_id"
// 而 uniq_family_member / uniq_family_member_active（family_id,user_id 两列）会报：
//   "UNIQUE constraint failed: family_members.family_id, family_members.user_id"
export function isSingleActiveFamilyViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  const code = (e?.code ?? "").toUpperCase();
  if (code !== "SQLITE_CONSTRAINT_UNIQUE") return false;
  const msg = e?.message ?? "";
  if (/uniq_family_single_active/i.test(msg)) return true;
  // 仅命中单列 user_id 的唯一约束才算（排除 family_id+user_id 的组合索引）。
  return /UNIQUE constraint failed:\s*family_members\.user_id(?!,)/i.test(msg);
}

export function registerFamilyRoutes(app: FastifyInstance, deps: { db: AppDb["db"]; jwt: Jwt }) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

  function requireMember(familyId: string, userId: string, roles?: Role[]) {
    const m = db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.familyId, familyId), eq(familyMembers.userId, userId), eq(familyMembers.isActive, true)))
      .get();
    if (!m) throw forbidden("FAMILY_FORBIDDEN", "你不是该共享账本成员");
    if (roles && !roles.includes(m.role as Role)) {
      throw forbidden("FAMILY_FORBIDDEN", "没有该操作的权限");
    }
    return m;
  }

  function activeFamilyOf(userId: string): typeof familyMembers.$inferSelect | undefined {
    return db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.userId, userId), eq(familyMembers.isActive, true)))
      .get();
  }

  function userByNickname(nickname: string): typeof users.$inferSelect | undefined {
    const key = nicknameKey(nickname);
    return db.select().from(users).where(eq(users.nicknameKey, key)).get();
  }

  function familyLedgerOf(familyId: string): typeof ledgers.$inferSelect | undefined {
    return db.select().from(ledgers).where(and(eq(ledgers.familyId, familyId), isNull(ledgers.deletedAt))).get();
  }

  // 把用户的当前账本从「正在退出/移除/删除的家庭」的账本切回个人默认账本（事务内调用，保持与成员变更一致）。
  // 必须额外确认 users.current_ledger_id 所属账本的 family_id 等于本次操作的 familyId，
  // 否则会误伤用户当前所在的新家庭（例如 B 退出 A 后加入了 C，删除 A 时不能把 B 从 C 账本切走）。
  function revertToPersonalLedgerInTx(userId: string, familyId: string) {
    const u = db.select().from(users).where(eq(users.id, userId)).get();
    if (!u || !u.currentLedgerId) return;
    const cur = db.select().from(ledgers).where(eq(ledgers.id, u.currentLedgerId)).get();
    if (cur?.familyId === familyId) {
      const personalLedger = db.select().from(ledgers).where(eq(ledgers.id, u.defaultLedgerId ?? "")).get();
      db.update(users)
        .set({ currentLedgerId: personalLedger?.id ?? null, updatedAt: new Date().toISOString() })
        .where(eq(users.id, userId))
        .run();
    }
  }

  app.post("/api/v1/families", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = createFamilySchema.parse(req.body);
    const now = new Date().toISOString();
    if (activeFamilyOf(userId)) {
      throw conflict("ALREADY_IN_FAMILY", "每个账号最多加入一个共享账本");
    }
    const familyId = randomUUID();
    const ledgerId = db.transaction(() => {
      db.insert(families).values({ id: familyId, name: body.name, ownerUserId: userId, createdAt: now, updatedAt: now }).run();
      db.insert(familyMembers)
        .values({ id: randomUUID(), familyId, userId, role: "owner", isActive: true, joinedAt: now })
        .run();
      const ledgerId = randomUUID();
      db.insert(ledgers)
        .values({ id: ledgerId, userId, familyId, name: body.name, currency: "CNY", isDefault: false, createdAt: now, updatedAt: now })
        .run();
      db.update(users).set({ currentLedgerId: ledgerId, updatedAt: now }).where(eq(users.id, userId)).run();

      // 创建自己的共享账本后，其他家庭发来的邀请已经不可再接受。
      // 必须与家庭、成员、账本和 current_ledger 的写入处于同一事务：
      // 任一步失败时，邀请仍保持 pending，用户可以继续处理原邀请。
      db.update(familyInvitations)
        .set({ status: "revoked", updatedAt: now })
        .where(and(eq(familyInvitations.targetUserId, userId), eq(familyInvitations.status, "pending")))
        .run();
      seedDefaultCategories(db, userId, ledgerId);
      return ledgerId;
    });
    return { item: { ...familyDto({ id: familyId, name: body.name, ownerUserId: userId, createdAt: now, updatedAt: now }), ledgerId } };
  });

  app.get("/api/v1/families", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const rows = db
      .select({ family: families, role: familyMembers.role })
      .from(familyMembers)
      .innerJoin(families, eq(families.id, familyMembers.familyId))
      .where(and(eq(familyMembers.userId, userId), eq(familyMembers.isActive, true)))
      .all();
    const items = rows.map((r) => ({ ...familyDto(r.family), myRole: r.role }));
    return { items };
  });

  app.get("/api/v1/families/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    requireMember(id, userId);
    const f = db.select().from(families).where(eq(families.id, id)).get();
    if (!f) throw notFound("FAMILY_NOT_FOUND", "共享账本不存在");
    const memberRows = db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.familyId, id), eq(familyMembers.isActive, true)))
      .all();
    const nicknames = new Map<string, string>();
    for (const m of memberRows) {
      const u = db.select().from(users).where(eq(users.id, m.userId)).get();
      if (u?.nickname) nicknames.set(m.userId, u.nickname);
    }
    const members = memberRows.map((m) => ({
      userId: m.userId,
      nickname: nicknames.get(m.userId) ?? "",
      role: m.role,
      joinedAt: m.joinedAt,
    }));
    const ledgerRows = db.select().from(ledgers).where(and(eq(ledgers.familyId, id), isNull(ledgers.deletedAt))).all();
    const invitations = db
      .select()
      .from(familyInvitations)
      .where(eq(familyInvitations.familyId, id))
      .all()
      .map((i) => ({
        id: i.id,
        targetUserId: i.targetUserId,
        inviterUserId: i.inviterUserId,
        status: i.status,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      }));
    return { item: { ...familyDto(f), members, ledgers: ledgerRows.map((l) => ({ id: l.id, name: l.name, currency: l.currency })), invitations } };
  });

  // Owner 按精确昵称邀请成员。目标已是其他家庭 active 成员时 → ALREADY_IN_FAMILY。
  app.post("/api/v1/families/:id/invitations", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    requireMember(id, userId, ["owner"]);
    const body = inviteSchema.parse(req.body);
    const err = validateNickname(body.nickname);
    if (err) throw badRequest("INVALID_NICKNAME", err);
    const target = userByNickname(body.nickname);
    if (!target || !target.nickname) throw notFound("USER_NOT_FOUND", "该昵称的用户不存在或尚未完成注册");

    // 已在当前家庭
    const inThis = db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.familyId, id), eq(familyMembers.userId, target.id), eq(familyMembers.isActive, true)))
      .get();
    if (inThis) throw conflict("ALREADY_IN_FAMILY", "该用户已是共享账本成员");

    // 已属于另一个家庭：不再创建新邀请
    const otherFamily = activeFamilyOf(target.id);
    if (otherFamily && otherFamily.familyId !== id) {
      throw conflict("ALREADY_IN_FAMILY", "该用户已加入另一个共享账本，请先退出再加入");
    }

    const pending = db
      .select()
      .from(familyInvitations)
      .where(and(eq(familyInvitations.familyId, id), eq(familyInvitations.targetUserId, target.id), eq(familyInvitations.status, "pending")))
      .get();
    if (pending) throw conflict("INVITATION_EXISTS", "已向该用户发送过待处理的邀请");

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS).toISOString();
    const inviteId = randomUUID();
    db.insert(familyInvitations)
      .values({
        id: inviteId,
        familyId: id,
        inviterUserId: userId,
        targetUserId: target.id,
        role: "member",
        status: "pending",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    writeAudit(db, {
      ledgerId: null,
      actorUserId: userId,
      entityType: "family_invitation",
      entityId: inviteId,
      action: "invite_created",
      afterJson: { familyId: id, targetUserId: target.id, targetNickname: target.nickname },
    });
    return { item: { id: inviteId, targetUserId: target.id, targetNickname: target.nickname, expiresAt, status: "pending" } };
  });

  app.get("/api/v1/families/:id/invitations", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    requireMember(id, userId, ["owner"]);
    const rows = db.select().from(familyInvitations).where(eq(familyInvitations.familyId, id)).all();
    const items = rows.map((i) => {
      const u = db.select().from(users).where(eq(users.id, i.targetUserId)).get();
      return {
        id: i.id,
        targetUserId: i.targetUserId,
        targetNickname: u?.nickname ?? "",
        inviterUserId: i.inviterUserId,
        role: i.role,
        status: i.status,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      };
    });
    return { items };
  });

  // 撤销邀请：仅可从 pending 单向转 revoked；非 pending → 409。
  app.delete("/api/v1/families/:id/invitations/:inviteId", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id, inviteId } = req.params as { id: string; inviteId: string };
    requireMember(id, userId, ["owner"]);
    const invite = db.select().from(familyInvitations).where(eq(familyInvitations.id, inviteId)).get();
    if (!invite || invite.familyId !== id) throw notFound("INVITATION_NOT_FOUND", "邀请不存在");
    const changed = db
      .update(familyInvitations)
      .set({ status: "revoked", updatedAt: new Date().toISOString() })
      .where(and(eq(familyInvitations.id, inviteId), eq(familyInvitations.status, "pending")))
      .run();
    if (changed.changes === 0) throw conflict("INVITATION_EXISTS", "邀请已被处理，无法撤销");
    return { ok: true };
  });

  // 我的待处理邀请箱
  app.get("/api/v1/families/invitations/pending", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const rows = db
      .select()
      .from(familyInvitations)
      .where(and(eq(familyInvitations.targetUserId, userId), eq(familyInvitations.status, "pending")))
      .all()
      .filter((i) => new Date(i.expiresAt).getTime() > Date.now());
    const items = rows.map((i) => {
      const f = db.select().from(families).where(eq(families.id, i.familyId)).get();
      const inviter = db.select().from(users).where(eq(users.id, i.inviterUserId)).get();
      return {
        id: i.id,
        familyId: i.familyId,
        familyName: f?.name ?? "",
        inviterNickname: inviter?.nickname ?? "",
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
      };
    });
    return { items };
  });

  // 接受邀请：单家庭约束 + 撤销该用户所有其他家庭的待处理邀请（不限当前 familyId）；
  // 并发接受不同家庭邀请由 uniq_family_single_active 唯一索引保证只成功一次，冲突转 409。
  app.post("/api/v1/families/invitations/:id/accept", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id: inviteId } = req.params as { id: string };
    const invite = db.select().from(familyInvitations).where(eq(familyInvitations.id, inviteId)).get();
    if (!invite || invite.targetUserId !== userId) throw notFound("INVITATION_NOT_FOUND", "邀请不存在");
    if (invite.status !== "pending") throw conflict("INVITATION_EXISTS", "邀请已被处理（重复接受）");
    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      throw conflict("INVITATION_EXPIRED", "邀请已过期");
    }
    const myFamily = activeFamilyOf(userId);
    if (myFamily && myFamily.familyId !== invite.familyId) {
      throw conflict("ALREADY_IN_FAMILY", "你已加入另一个共享账本");
    }
    const now = new Date().toISOString();
    try {
      db.transaction(() => {
        // 原子认领：仅当仍为 pending 才成功，防止重复接受
        const claimed = db
          .update(familyInvitations)
          .set({ status: "accepted", acceptedAt: now, updatedAt: now })
          .where(and(eq(familyInvitations.id, inviteId), eq(familyInvitations.status, "pending")))
          .run();
        if (claimed.changes === 0) throw conflict("INVITATION_EXISTS", "邀请已被处理");

        // 撤销该用户所有其他家庭的待处理邀请（不限制为当前 familyId）
        db.update(familyInvitations)
          .set({ status: "revoked", updatedAt: now })
          .where(and(eq(familyInvitations.targetUserId, userId), eq(familyInvitations.status, "pending"), ne(familyInvitations.id, inviteId)))
          .run();

        const existing = db
          .select()
          .from(familyMembers)
          .where(and(eq(familyMembers.familyId, invite.familyId), eq(familyMembers.userId, userId)))
          .get();
        if (existing) {
          db.update(familyMembers)
            .set({ isActive: true, role: "member", joinedAt: now })
            .where(eq(familyMembers.id, existing.id))
            .run();
        } else {
          db.insert(familyMembers)
            .values({ id: randomUUID(), familyId: invite.familyId, userId, role: "member", isActive: true, joinedAt: now })
            .run();
        }
        const familyLedger = familyLedgerOf(invite.familyId);
        if (familyLedger) {
          db.update(users).set({ currentLedgerId: familyLedger.id, updatedAt: now }).where(eq(users.id, userId)).run();
        }
        writeAudit(db, {
          ledgerId: null,
          actorUserId: userId,
          entityType: "family",
          entityId: invite.familyId,
          action: "invite_accepted",
          afterJson: { invitationId: inviteId, role: "member" },
        });
      });
    } catch (e) {
      if (isSingleActiveFamilyViolation(e)) throw conflict("ALREADY_IN_FAMILY", "你已加入另一个共享账本");
      throw e;
    }
    return { ok: true };
  });

  // 拒绝邀请：仅可从 pending 转 declined；非 pending → 409。
  app.post("/api/v1/families/invitations/:id/decline", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id: inviteId } = req.params as { id: string };
    const invite = db.select().from(familyInvitations).where(eq(familyInvitations.id, inviteId)).get();
    if (!invite || invite.targetUserId !== userId) throw notFound("INVITATION_NOT_FOUND", "邀请不存在");
    const changed = db
      .update(familyInvitations)
      .set({ status: "declined", updatedAt: new Date().toISOString() })
      .where(and(eq(familyInvitations.id, inviteId), eq(familyInvitations.status, "pending")))
      .run();
    if (changed.changes === 0) throw conflict("INVITATION_EXISTS", "邀请已被处理（重复拒绝）");
    return { ok: true };
  });

  app.patch("/api/v1/families/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    requireMember(id, userId, ["owner"]);
    const body = patchFamilySchema.parse(req.body);
    const f = db.select().from(families).where(eq(families.id, id)).get();
    if (!f) throw notFound("FAMILY_NOT_FOUND", "共享账本不存在");
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.name !== undefined) patch.name = body.name;
    db.transaction(() => {
      db.update(families).set(patch).where(eq(families.id, id)).run();
      if (body.name !== undefined) {
        db.update(ledgers).set({ name: body.name, updatedAt: now }).where(and(eq(ledgers.familyId, id), isNull(ledgers.deletedAt))).run();
      }
    });
    const updated = db.select().from(families).where(eq(families.id, id)).get();
    return { item: familyDto(updated as typeof families.$inferSelect) };
  });

  // 成员退出：成员变更 + 账本回退 + 审计在同一事务
  app.post("/api/v1/families/:id/exit", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    const me = requireMember(id, userId);
    if (me.role === "owner") throw badRequest("OWNER_CANNOT_EXIT", "共享账本所有者请删除共享账本或先转移所有权");
    db.transaction(() => {
      db.update(familyMembers)
        .set({ isActive: false })
        .where(and(eq(familyMembers.familyId, id), eq(familyMembers.userId, userId)))
        .run();
      revertToPersonalLedgerInTx(userId, id);
      writeAudit(db, {
        ledgerId: null,
        actorUserId: userId,
        entityType: "family",
        entityId: id,
        action: "member_exit",
        afterJson: { memberUserId: userId },
      });
    });
    return { ok: true };
  });

  // 移除成员（Owner）：成员变更 + 账本回退 + 审计在同一事务
  app.delete("/api/v1/families/:id/members/:memberUserId", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id, memberUserId } = req.params as { id: string; memberUserId: string };
    requireMember(id, userId, ["owner"]);
    if (memberUserId === userId) throw badRequest("CANNOT_REMOVE_SELF", "不能移除自己，请使用退出共享账本");
    db.transaction(() => {
      db.update(familyMembers)
        .set({ isActive: false })
        .where(and(eq(familyMembers.familyId, id), eq(familyMembers.userId, memberUserId)))
        .run();
      revertToPersonalLedgerInTx(memberUserId, id);
      writeAudit(db, {
        ledgerId: null,
        actorUserId: userId,
        entityType: "family",
        entityId: id,
        action: "member_remove",
        afterJson: { memberUserId },
      });
    });
    return { ok: true };
  });

  // 转移所有权（仅 Owner）：家族所有权 + 角色变更 + 审计同一事务
  app.post("/api/v1/families/:id/transfer", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    requireMember(id, userId, ["owner"]);
    const body = transferSchema.parse(req.body);
    const target = db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.familyId, id), eq(familyMembers.userId, body.memberUserId), eq(familyMembers.isActive, true)))
      .get();
    if (!target) throw notFound("MEMBER_NOT_FOUND", "成员不存在");
    if (target.userId === userId) throw badRequest("ALREADY_OWNER", "你已是共享账本所有者");
    const now = new Date().toISOString();
    db.transaction(() => {
      db.update(families).set({ ownerUserId: body.memberUserId, updatedAt: now }).where(eq(families.id, id)).run();
      db.update(familyMembers).set({ role: "member" }).where(and(eq(familyMembers.familyId, id), eq(familyMembers.userId, userId))).run();
      db.update(familyMembers).set({ role: "owner" }).where(eq(familyMembers.id, target.id)).run();
      writeAudit(db, {
        ledgerId: null,
        actorUserId: userId,
        entityType: "family",
        entityId: id,
        action: "ownership_transfer",
        afterJson: { fromUserId: userId, toUserId: body.memberUserId },
      });
    });
    return { ok: true };
  });

  // 删除家庭（仅 Owner）：软删除共享账本、成员/邀请/审计与账本回退同一事务
  app.delete("/api/v1/families/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    requireMember(id, userId, ["owner"]);
    // 只处理该家庭当前 active 成员：已退出/已移除的用户不影响（他们可能已属于并停留在新的家庭）。
    const memberUserIds = db
      .select({ userId: familyMembers.userId })
      .from(familyMembers)
      .where(and(eq(familyMembers.familyId, id), eq(familyMembers.isActive, true)))
      .all()
      .map((r) => r.userId);
    const now = new Date().toISOString();
    db.transaction(() => {
      db.update(familyMembers).set({ isActive: false }).where(eq(familyMembers.familyId, id)).run();
      db.update(familyInvitations).set({ status: "revoked", updatedAt: now }).where(eq(familyInvitations.familyId, id)).run();
      const fLedgers = db.select().from(ledgers).where(eq(ledgers.familyId, id)).all();
      for (const l of fLedgers) {
        db.update(ledgers).set({ deletedAt: now, updatedAt: now }).where(eq(ledgers.id, l.id)).run();
      }
      // 仅对当前 active 成员回退个人账本（且只在 current_ledger 属于本家庭时才切）
      for (const mid of memberUserIds) revertToPersonalLedgerInTx(mid, id);
      db.delete(families).where(eq(families.id, id)).run();
      writeAudit(db, {
        ledgerId: null,
        actorUserId: userId,
        entityType: "family",
        entityId: id,
        action: "family_delete",
        afterJson: {},
      });
    });
    return { ok: true };
  });

  // ---------------- 旧多角色流程：保留路由但统一 410 ----------------
  app.post("/api/v1/families/:id/members", { preHandler: auth }, async () => {
    throw new AppError(410, "FAMILY_FLOW_REMOVED", "直接添加成员已下线，请使用精确昵称邀请");
  });
  app.patch("/api/v1/families/:id/members/:memberUserId", { preHandler: auth }, async () => {
    throw new AppError(410, "FAMILY_FLOW_REMOVED", "多级角色已下线，共享账本仅保留 owner/member");
  });

  // ---------------- 账本 ----------------
  app.get("/api/v1/ledgers", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const myLedgers = db.select().from(ledgers).where(and(eq(ledgers.userId, userId), isNull(ledgers.deletedAt))).all();
    const activeFamily = activeFamilyOf(userId);
    let familyLedgers: Array<typeof ledgers.$inferSelect> = [];
    if (activeFamily) {
      familyLedgers = db.select().from(ledgers).where(and(eq(ledgers.familyId, activeFamily.familyId), isNull(ledgers.deletedAt))).all();
    }
    const map = new Map<string, typeof ledgers.$inferSelect>();
    for (const l of [...myLedgers, ...familyLedgers]) map.set(l.id, l);
    const u = db.select().from(users).where(eq(users.id, userId)).get();
    const items = [...map.values()].map((l) => ({
      id: l.id,
      name: l.name,
      currency: l.currency,
      isDefault: l.isDefault,
      familyId: l.familyId,
      isCurrent: u?.currentLedgerId === l.id || (!u?.currentLedgerId && u?.defaultLedgerId === l.id),
    }));
    return { items };
  });

  app.post("/api/v1/ledgers/switch", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = switchLedgerSchema.parse(req.body);
    const ledger = getAccessibleLedger(db, userId, body.ledgerId);
    db.update(users)
      .set({ currentLedgerId: ledger.id, updatedAt: new Date().toISOString() })
      .where(eq(users.id, userId))
      .run();
    return { ok: true, item: { id: ledger.id, name: ledger.name, familyId: ledger.familyId } };
  });
}
