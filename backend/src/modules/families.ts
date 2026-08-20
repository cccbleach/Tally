import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { families, familyMembers, ledgers, users } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { getAccessibleLedger } from "../lib/access.js";
import { writeAudit } from "../lib/audit.js";
import type { Jwt } from "../auth/jwt.js";

const createFamilySchema = z.object({
  name: z.string().min(1, "家庭名称不能为空").max(40, "家庭名称过长"),
});

const addMemberSchema = z
  .object({
    userId: z.string().optional(),
    account: z.string().optional(), // 手机号/邮箱，二选一
  })
  .refine((v) => !!v.userId || !!v.account, { message: "请提供 userId 或 account" });

const patchFamilySchema = z.object({
  name: z.string().min(1).max(40).optional(),
  role: z.enum(["admin", "member"]).optional(),
});

const switchLedgerSchema = z.object({
  ledgerId: z.string().min(1, "账本不能为空"),
});

function familyDto(f: typeof families.$inferSelect) {
  return { id: f.id, name: f.name, ownerUserId: f.ownerUserId, createdAt: f.createdAt, updatedAt: f.updatedAt };
}

export function registerFamilyRoutes(app: FastifyInstance, deps: { db: AppDb["db"]; jwt: Jwt }) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

  function requireMember(familyId: string, userId: string, roles?: ("owner" | "admin" | "member")[]) {
    const m = db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.familyId, familyId), eq(familyMembers.userId, userId), eq(familyMembers.isActive, true)))
      .get();
    if (!m) throw forbidden("FAMILY_FORBIDDEN", "你不是该家庭成员");
    if (roles && !roles.includes(m.role as "owner" | "admin" | "member")) {
      throw forbidden("FAMILY_FORBIDDEN", "没有该操作的权限");
    }
    return m;
  }

  app.post("/api/v1/families", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = createFamilySchema.parse(req.body);
    const now = new Date().toISOString();
    const familyId = randomUUID();
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
    return { item: { ...familyDto({ id: familyId, name: body.name, ownerUserId: userId, createdAt: now, updatedAt: now }), ledgerId } };
  });

  app.get("/api/v1/families", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const rows = db
      .select({ family: families })
      .from(familyMembers)
      .innerJoin(families, eq(families.id, familyMembers.familyId))
      .where(and(eq(familyMembers.userId, userId), eq(familyMembers.isActive, true)))
      .all();
    const items = rows.map((r) => familyDto(r.family));
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
    return { item: { ...familyDto(f), members, ledgers: ledgerRows.map((l) => ({ id: l.id, name: l.name, currency: l.currency })) } };
  });

  app.post("/api/v1/families/:id/members", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const { id } = req.params as { id: string };
    requireMember(id, userId, ["owner", "admin"]);
    const body = addMemberSchema.parse(req.body);
    const target = body.userId
      ? db.select().from(users).where(eq(users.id, body.userId)).get()
      : db.select().from(users).where(eq(users.email, (body.account ?? "").trim().toLowerCase())).get();
    if (!target) throw notFound("USER_NOT_FOUND", "用户不存在");
    const now = new Date().toISOString();
    const existing = db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.familyId, id), eq(familyMembers.userId, target.id)))
      .get();
    if (existing) {
      db.update(familyMembers)
        .set({ isActive: true, joinedAt: now })
        .where(eq(familyMembers.id, existing.id))
        .run();
    } else {
      db.insert(familyMembers)
        .values({ id: randomUUID(), familyId: id, userId: target.id, role: "member", isActive: true, joinedAt: now })
        .run();
    }
    writeAudit(db, {
      ledgerId: null,
      actorUserId: userId,
      entityType: "family",
      entityId: id,
      action: "member_add",
      afterJson: { memberUserId: target.id, role: "member" },
    });
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
    if (body.role !== undefined) {
      // 简单实现：更新所有成员的默认角色由前端指定 userId 的场景在后续细化
    }
    const updated = db.select().from(families).where(eq(families.id, id)).get();
    return { item: familyDto(updated as typeof families.$inferSelect) };
  });

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

  app.get("/api/v1/ledgers", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    // 个人账本 + 所在家庭的账本
    const myLedgers = db.select().from(ledgers).where(eq(ledgers.userId, userId)).all();
    const myFamilies = db
      .select({ familyId: familyMembers.familyId })
      .from(familyMembers)
      .where(and(eq(familyMembers.userId, userId), eq(familyMembers.isActive, true)))
      .all();
    const familyIds = myFamilies.map((r) => r.familyId);
    const familyLedgers = familyIds.length > 0 ? db.select().from(ledgers).where(inArray(ledgers.familyId, familyIds)).all() : [];
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
