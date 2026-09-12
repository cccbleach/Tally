import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { categories } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { notFound, conflict } from "../lib/errors.js";
import { getAccessibleLedger } from "../lib/access.js";
import { requireLedgerPermission } from "../lib/authorization.js";
import type { Jwt } from "../auth/jwt.js";

const createSchema = z.object({
  name: z.string().min(1, "分类名不能为空").max(20, "分类名过长"),
  type: z.enum(["income", "expense"]),
  icon: z.string().max(100).optional(),
  color: z.string().max(20).optional(),
  sortOrder: z.number().int().optional(),
  ledgerId: z.string().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(20).optional(),
  icon: z.string().max(100).nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  sortOrder: z.number().int().optional(),
  ledgerId: z.string().optional(),
  // 乐观锁：可选。若提供且与服务端当前 updatedAt 不一致则返回 409（与流水同一套约定）。
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

type CategoryRow = typeof categories.$inferSelect;

function toDto(row: CategoryRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    icon: row.icon,
    color: row.color,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt,
  };
}

export function registerCategoryRoutes(app: FastifyInstance, deps: { db: AppDb["db"]; jwt: Jwt }) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

  app.get("/api/v1/categories", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const rows = db
      .select()
      .from(categories)
      .where(eq(categories.ledgerId, ledgerId))
      .orderBy(asc(categories.sortOrder), asc(categories.createdAt))
      .all();
    return { items: rows.map(toDto) };
  });

  app.post("/api/v1/categories", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = createSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    requireLedgerPermission(db, userId, ledgerId, "category:manage");
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      userId,
      ledgerId,
      name: body.name,
      type: body.type,
      icon: body.icon ?? null,
      color: body.color ?? null,
      sortOrder: body.sortOrder ?? 999,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(categories).values(row).run();
    return { item: toDto(row) };
  });

  app.patch("/api/v1/categories/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = updateSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
      requireLedgerPermission(db, userId, ledgerId, "category:manage");
    const { id } = req.params as { id: string };
    const existing = db
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.ledgerId, ledgerId)))
      .get();
    if (!existing) throw notFound("CATEGORY_NOT_FOUND", "分类不存在");
    // 乐观锁：家庭共享账本下两台设备并发改同一分类时，过期方收到 409 而不是静默覆盖
    if (body.expectedUpdatedAt && existing.updatedAt !== body.expectedUpdatedAt) {
      throw conflict("CONFLICT", "分类已被其他端修改，请刷新后重试");
    }
    const patch: Partial<typeof categories.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.color !== undefined) patch.color = body.color;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    patch.updatedAt = new Date().toISOString();
    db.update(categories)
      .set(patch)
      .where(and(eq(categories.id, id), eq(categories.ledgerId, ledgerId)))
      .run();
    const updated = db
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.ledgerId, ledgerId)))
      .get();
    return { item: toDto(updated as CategoryRow) };
  });

  app.delete("/api/v1/categories/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
      requireLedgerPermission(db, userId, ledgerId, "category:manage");
    const { id } = req.params as { id: string };
    const existing = db
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.ledgerId, ledgerId)))
      .get();
    if (!existing) throw notFound("CATEGORY_NOT_FOUND", "分类不存在");
    db.delete(categories)
      .where(and(eq(categories.id, id), eq(categories.ledgerId, ledgerId)))
      .run();
    return { ok: true };
  });
}
