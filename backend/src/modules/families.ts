import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { families, familyMembers, familyInvitations, ledgers, users } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { getAccessibleLedger } from "../lib/access.js";
import { writeAudit } from "../lib/audit.js";
import { seedDefaultCategories } from "../db/seed.js";
import type { Jwt } from "../auth/jwt.js";

type Role = "owner" | "admin" | "member" | "viewer";
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 邀请 7 天有效

const createFamilySchema = z.object({
  name: z.string().min(1, "家庭名称不能为空").max(40, "家庭名称过长"),
});

const addMemberSchema = z.object({
  account: z.string().min(3, "请输入邮箱或手机号"),
});

const inviteSchema = z.object({
  account: z.string().min(3, "请输入邮箱或手机号"),
  role: z.enum(["member", "viewer", "admin"]).optional(),
});

const patchFamilySchema = z.object({
  name: z.string().min(1).max(40).optional(),
});

const patchMemberRoleSchema = z.object({
  role: z.enum(["member", "viewer", "admin"]),
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

// 账号归一化与哈希：邮箱小写；手机号去空格。
function normalizeAccount(account: string): string {
  const t = account.trim();
  if (t.includes("@")) return t.toLowerCase();
  return t.replace(/\s+/g, "");
}
function hashAccount(account: string): string {
  return createHash("sha256").update(normalizeAccount(account), "utf8").digest("hex");
}
function generateInviteToken(): string {
  return randomBytes(24).toString("base64url");
}
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
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
    if (!m) throw forbidden("FAMILY_FORBIDDEN", "你不是该家庭成员");
    if (roles && !roles.includes(m.role as Role)) {
      throw forbidden("FAMILY_FORBIDDEN", "没有该操作的权限");
    }
    return m;
  }

  // 把用户的当前账本从家庭账本切回个人默认账本（成员退出/被移除时调用）
  function revertToPersonalLedger(userId: string) {
    const u = db.select().from(users).where(eq(users.id, userId)).get();
    if (!u) return;
    if (!u.currentLedgerId) return;
    const cur = db.select().from(ledgers).where(eq(ledgers.id, u.currentLedgerId)).get();
    // 仅当当前账本是家庭账本时才切回；否则保持不动
    if (cur?.familyId) {
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
    const familyId = randomUUID();
    const tx = db.transaction(() => {
      db.insert(families).values({ id: familyId, name: body.name, ownerUserId: userId, createdAt: now, updatedAt: now }).run();
      db.insert(familyMembers)
        .values({ id: randomUUID(), familyId, userId, role: "owner", isActive: true, joinedAt: now })
        .run();
      // 自动创建家庭共享账本并切换为当前账本
      const ledgerId = randomUUID();
      db.insert(ledgers)
        .values({ id: ledgerId, userId, familyId, name: body.name + "账本", currency: "CNY", isDefault: false, createdAt: now, updatedAt: now })
        .run();
      db.update(users).set({ currentLedgerId: ledgerId, updatedAt: now }).where(eq(users.id, userId)).run();
      // 家庭账本也播种默认分类，成员才能直接记账
      seedDefaultCategories(db, userId, ledgerId);
      return { familyId, ledgerId };
    });
    return { item: { ...familyDto({ id: tx.familyId, name: body.name, ownerUserId: userId, createdAt: now, updatedAt: now }), ledgerId: tx.ledgerId } };
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
    if (!f) throw notFound("FAMILY_NOT_FOUND", "家庭不存在");
    const members = db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.familyId, id), eq(familyMembers.isActive, true)))
      .all()
      .map((m) => ({ userId: m.userId, role: m.role, joinedAt: m.joinedAt }));
    const ledgerRows = db.select().from(ledgers).where(eq(ledgers.familyId, id)).all();
    const invitations = db
      .select()
      .from(familyInvitations)
      .where(and(eq(familyInvitations.familyId, id), eq(familyInvitations.status, "pending")))
      .all()
      .map((i) => ({ id: i.id, role: i.role, targetAccountHash: i.targetAccountHash.slice(0, 12), expiresAt: i.expiresAt, createdAt: i.createdAt }));
    return { item: { ...familyDto(f), members, ledgers: ledgerRows.map((l) => ({ id: l.id, name: l.name, currency: l.currency })), invitations } };
  });

  // 直接添加已注册成员（兼容旧客户端）；新客户端建议使用邀请流程。
  app.post("/api/v1/families/:id/members", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    requireMember(id, userId, ["owner", "admin"]);
    const body = addMemberSchema.parse(req.body);
    const account = normalizeAccount(body.account);
    const target = db.select().from(users).where(eq(users.email, account)).get();
    if (!target) throw notFound("USER_NOT_FOUND", "该账号尚未注册");
    const existing = db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.familyId, id), eq(familyMembers.userId, target.id)))
      .get();
    if (existing?.isActive) throw conflict("MEMBER_EXISTS", "该用户已是家庭成员");
    const now = new Date().toISOString();
    db.transaction(() => {
      if (existing) {
        db.update(familyMembers)
          .set({ isActive: true, role: "member", joinedAt: now })
          .where(eq(familyMembers.id, existing.id))
          .run();
      } else {
        db.insert(familyMembers)
          .values({ id: randomUUID(), familyId: id, userId: target.id, role: "member", isActive: true, joinedAt: now })
          .run();
      }
      const familyLedger = db.select().from(ledgers).where(eq(ledgers.familyId, id)).get();
      if (familyLedger) {
        db.update(users).set({ currentLedgerId: familyLedger.id, updatedAt: now }).where(eq(users.id, target.id)).run();
      }
      writeAudit(db, {
        ledgerId: null,
        actorUserId: userId,
        entityType: "family",
        entityId: id,
        action: "member_add",
        afterJson: { memberUserId: target.id },
      });
    });
    return { ok: true };
  });

  // 发送邀请：生成一次性邀请 token，仅在此处返回明文
  app.post("/api/v1/families/:id/invitations", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    requireMember(id, userId, ["owner", "admin"]);
    const body = inviteSchema.parse(req.body);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS).toISOString();
    const token = generateInviteToken();
    const inviteId = randomUUID();
    db.insert(familyInvitations)
      .values({
        id: inviteId,
        familyId: id,
        inviterUserId: userId,
        targetAccountHash: hashAccount(body.account),
        role: body.role ?? "member",
        tokenHash: hashToken(token),
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
      afterJson: { familyId: id, role: body.role ?? "member" },
    });
    return { item: { id: inviteId, token, role: body.role ?? "member", expiresAt } };
  });

  app.get("/api/v1/families/:id/invitations", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    requireMember(id, userId, ["owner", "admin"]);
    const rows = db.select().from(familyInvitations).where(eq(familyInvitations.familyId, id)).all();
    return { items: rows.map((i) => ({ id: i.id, role: i.role, status: i.status, expiresAt: i.expiresAt, createdAt: i.createdAt })) };
  });

  app.delete("/api/v1/families/:id/invitations/:inviteId", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id, inviteId } = req.params as { id: string; inviteId: string };
    requireMember(id, userId, ["owner", "admin"]);
    const invite = db.select().from(familyInvitations).where(eq(familyInvitations.id, inviteId)).get();
    if (!invite || invite.familyId !== id) throw notFound("INVITATION_NOT_FOUND", "邀请不存在");
    db.update(familyInvitations)
      .set({ status: "revoked", updatedAt: new Date().toISOString() })
      .where(eq(familyInvitations.id, inviteId))
      .run();
    return { ok: true };
  });

  // 接受邀请：受邀人登录后凭 token 加入。目标账号需与受邀账号一致。
  app.post("/api/v1/families/invitations/:token/accept", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { token } = req.params as { token: string };
    const invite = db.select().from(familyInvitations).where(eq(familyInvitations.tokenHash, hashToken(token))).get();
    if (!invite || invite.status !== "pending") throw notFound("INVITATION_NOT_FOUND", "邀请不存在或已失效");
    const user = db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw notFound("USER_NOT_FOUND", "用户不存在");
    if (hashAccount(user.email) !== invite.targetAccountHash) {
      throw forbidden("INVITATION_MISMATCH", "该邀请不是发给当前账号");
    }
    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      throw conflict("INVITATION_EXPIRED", "邀请已过期");
    }
    const now = new Date().toISOString();
    db.transaction(() => {
      db.update(familyInvitations)
        .set({ status: "accepted", acceptedAt: now, updatedAt: now })
        .where(eq(familyInvitations.id, invite.id))
        .run();
      const existing = db
        .select()
        .from(familyMembers)
        .where(and(eq(familyMembers.familyId, invite.familyId), eq(familyMembers.userId, userId)))
        .get();
      if (existing) {
        db.update(familyMembers)
          .set({ isActive: true, role: invite.role as Role, joinedAt: now })
          .where(eq(familyMembers.id, existing.id))
          .run();
      } else {
        db.insert(familyMembers)
          .values({ id: randomUUID(), familyId: invite.familyId, userId, role: invite.role as Role, isActive: true, joinedAt: now })
          .run();
      }
      // 受邀后自动切换为家庭账本
      const familyLedger = db.select().from(ledgers).where(eq(ledgers.familyId, invite.familyId)).get();
      if (familyLedger) {
        db.update(users).set({ currentLedgerId: familyLedger.id, updatedAt: now }).where(eq(users.id, userId)).run();
      }
      writeAudit(db, {
        ledgerId: null,
        actorUserId: userId,
        entityType: "family",
        entityId: invite.familyId,
        action: "invite_accepted",
        afterJson: { invitationId: invite.id, role: invite.role },
      });
    });
    return { ok: true };
  });

  app.post("/api/v1/families/invitations/:token/decline", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { token } = req.params as { token: string };
    const invite = db.select().from(familyInvitations).where(eq(familyInvitations.tokenHash, hashToken(token))).get();
    if (!invite || invite.status !== "pending") throw notFound("INVITATION_NOT_FOUND", "邀请不存在或已失效");
    db.update(familyInvitations)
      .set({ status: "declined", updatedAt: new Date().toISOString() })
      .where(eq(familyInvitations.id, invite.id))
      .run();
    return { ok: true };
  });

  app.patch("/api/v1/families/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    requireMember(id, userId, ["owner", "admin"]);
    const body = patchFamilySchema.parse(req.body);
    const f = db.select().from(families).where(eq(families.id, id)).get();
    if (!f) throw notFound("FAMILY_NOT_FOUND", "家庭不存在");
    const patch: Partial<typeof families.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) patch.name = body.name;
    db.update(families).set(patch).where(eq(families.id, id)).run();
    const updated = db.select().from(families).where(eq(families.id, id)).get();
    return { item: familyDto(updated as typeof families.$inferSelect) };
  });

  // 修改成员角色（owner/admin；owner 不能通过此接口被改动）
  app.patch("/api/v1/families/:id/members/:memberUserId", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id, memberUserId } = req.params as { id: string; memberUserId: string };
    requireMember(id, userId, ["owner", "admin"]);
    const body = patchMemberRoleSchema.parse(req.body);
    const target = db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.familyId, id), eq(familyMembers.userId, memberUserId), eq(familyMembers.isActive, true)))
      .get();
    if (!target) throw notFound("MEMBER_NOT_FOUND", "成员不存在");
    if (target.role === "owner") throw forbidden("FAMILY_FORBIDDEN", "不能修改家庭创建者的角色");
    db.update(familyMembers)
      .set({ role: body.role, joinedAt: target.joinedAt })
      .where(eq(familyMembers.id, target.id))
      .run();
    writeAudit(db, {
      ledgerId: null,
      actorUserId: userId,
      entityType: "family",
      entityId: id,
      action: "member_role_change",
      afterJson: { memberUserId, role: body.role },
    });
    return { ok: true };
  });

  // 退出家庭：成员（非 owner）可自行退出，并切回个人账本
  app.post("/api/v1/families/:id/exit", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    const me = requireMember(id, userId);
    if (me.role === "owner") throw badRequest("OWNER_CANNOT_EXIT", "家庭创建者请使用删除家庭或转移所有权");
    db.update(familyMembers)
      .set({ isActive: false })
      .where(and(eq(familyMembers.familyId, id), eq(familyMembers.userId, userId)))
      .run();
    revertToPersonalLedger(userId);
    writeAudit(db, {
      ledgerId: null,
      actorUserId: userId,
      entityType: "family",
      entityId: id,
      action: "member_exit",
      afterJson: { memberUserId: userId },
    });
    return { ok: true };
  });

  // 移除成员（owner/admin）：移除后该成员切回个人账本
  app.delete("/api/v1/families/:id/members/:memberUserId", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id, memberUserId } = req.params as { id: string; memberUserId: string };
    const me = requireMember(id, userId, ["owner", "admin"]);
    if (memberUserId === userId) throw badRequest("CANNOT_REMOVE_SELF", "不能移除自己，请使用退出家庭");
    if (me.role === "admin" && memberUserId === (db.select().from(families).where(eq(families.id, id)).get()?.ownerUserId)) {
      throw forbidden("FAMILY_FORBIDDEN", "不能移除家庭创建者");
    }
    db.update(familyMembers)
      .set({ isActive: false })
      .where(and(eq(familyMembers.familyId, id), eq(familyMembers.userId, memberUserId)))
      .run();
    revertToPersonalLedger(memberUserId);
    writeAudit(db, {
      ledgerId: null,
      actorUserId: userId,
      entityType: "family",
      entityId: id,
      action: "member_remove",
      afterJson: { memberUserId },
    });
    return { ok: true };
  });

  // 转移所有权（仅 owner）
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
    if (target.userId === userId) throw badRequest("ALREADY_OWNER", "你已是家庭创建者");
    const now = new Date().toISOString();
    db.transaction(() => {
      db.update(families).set({ ownerUserId: body.memberUserId, updatedAt: now }).where(eq(families.id, id)).run();
      db.update(familyMembers).set({ role: "admin" }).where(and(eq(familyMembers.familyId, id), eq(familyMembers.userId, userId))).run();
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

  // 删除家庭（仅 owner）：移除成员、邀请与家庭账本归属
  app.delete("/api/v1/families/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    requireMember(id, userId, ["owner"]);
    // 家庭行删除会级联删除 family_members（ON DELETE CASCADE），
    // 因此必须在删除前捕获全部成员 userId，用于事务后统一切回个人账本。
    const memberUserIds = db
      .select({ userId: familyMembers.userId })
      .from(familyMembers)
      .where(eq(familyMembers.familyId, id))
      .all()
      .map((r) => r.userId);
    const now = new Date().toISOString();
    db.transaction(() => {
      db.update(familyMembers).set({ isActive: false }).where(eq(familyMembers.familyId, id)).run();
      db.update(familyInvitations).set({ status: "revoked", updatedAt: now }).where(eq(familyInvitations.familyId, id)).run();
      const fLedgers = db.select().from(ledgers).where(eq(ledgers.familyId, id)).all();
      for (const l of fLedgers) {
        // 软删除家庭账本：保留历史财务数据，但使任何原成员（含原属主）都无法再访问。
        // 避免把家庭账本变成“匿名但仍被原创建者访问”的个人账本。
        db.update(ledgers).set({ deletedAt: now, updatedAt: now }).where(eq(ledgers.id, l.id)).run();
      }
      db.delete(families).where(eq(families.id, id)).run();
    });
    for (const mid of memberUserIds) revertToPersonalLedger(mid);
    writeAudit(db, {
      ledgerId: null,
      actorUserId: userId,
      entityType: "family",
      entityId: id,
      action: "family_delete",
      afterJson: {},
    });
    return { ok: true };
  });

  app.get("/api/v1/ledgers", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const myLedgers = db.select().from(ledgers).where(and(eq(ledgers.userId, userId), isNull(ledgers.deletedAt))).all();
    const myFamilies = db
      .select({ familyId: familyMembers.familyId })
      .from(familyMembers)
      .where(and(eq(familyMembers.userId, userId), eq(familyMembers.isActive, true)))
      .all();
    const familyIds = myFamilies.map((r) => r.familyId);
    const familyLedgers =
      familyIds.length > 0
        ? db.select().from(ledgers).where(and(inArray(ledgers.familyId, familyIds), isNull(ledgers.deletedAt))).all()
        : [];
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
