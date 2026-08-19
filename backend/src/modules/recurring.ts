import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { accounts, categories, recurring } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { getLedgerId } from "../lib/ledger.js";
import { accountNameMap } from "../repositories/accountRepository.js";
import { categoryNameMap } from "../repositories/categoryRepository.js";
import type { Jwt } from "../auth/jwt.js";

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;

const createSchema = z.object({
  accountId: z.string().min(1, "账户不能为空"),
  categoryId: z.string().min(1, "分类不能为空"),
  type: z.enum(["income", "expense"]),
  amount: z.number().int("金额必须为整数（分）").positive("金额必须大于 0"),
  note: z.string().max(500, "备注过长").optional(),
  frequency: z.enum(FREQUENCIES),
  interval: z.number().int().min(1, "间隔至少为 1").max(365).default(1),
  startDate: z.string().regex(dateRe, "开始日期格式应为 YYYY-MM-DD"),
  endDate: z.string().regex(dateRe, "结束日期格式应为 YYYY-MM-DD").nullable().optional(),
});

const updateSchema = z.object({
  accountId: z.string().min(1).optional(),
  categoryId: z.string().min(1).optional(),
  amount: z.number().int().positive().optional(),
  note: z.string().max(500).nullable().optional(),
  frequency: z.enum(FREQUENCIES).optional(),
  interval: z.number().int().min(1).max(365).optional(),
  startDate: z.string().regex(dateRe).optional(),
  endDate: z.string().regex(dateRe).nullable().optional(),
  isActive: z.boolean().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

type RecurringRow = typeof recurring.$inferSelect;

function toDto(r: RecurringRow, accountName: string | null, categoryName: string | null) {
  return {
    id: r.id,
    accountId: r.accountId,
    categoryId: r.categoryId,
    type: r.type,
    amount: r.amount,
    note: r.note,
    frequency: r.frequency,
    interval: r.interval,
    startDate: r.startDate,
    endDate: r.endDate,
    nextRunDate: r.nextRunDate,
    lastGeneratedDate: r.lastGeneratedDate,
    isActive: r.isActive,
    updatedAt: r.updatedAt,
    accountName,
    categoryName,
  };
}

export function registerRecurringRoutes(app: FastifyInstance, deps: { db: AppDb["db"]; jwt: Jwt }) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

  app.get("/api/v1/recurring", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const ledgerId = getLedgerId(db, userId);
    const rows = db
      .select()
      .from(recurring)
      .where(and(eq(recurring.userId, userId), eq(recurring.ledgerId, ledgerId)))
      .orderBy(asc(recurring.nextRunDate))
      .all();
    const am = accountNameMap(db, userId, ledgerId);
    const cm = categoryNameMap(db, userId, ledgerId);
    return { items: rows.map((r) => toDto(r, am.get(r.accountId) ?? null, r.categoryId ? (cm.get(r.categoryId) ?? null) : null)) };
  });

  app.post("/api/v1/recurring", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const ledgerId = getLedgerId(db, userId);
    const body = createSchema.parse(req.body);
    const account = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, body.accountId), eq(accounts.userId, userId), eq(accounts.ledgerId, ledgerId)))
      .get();
    if (!account) throw badRequest("ACCOUNT_NOT_FOUND", "账户不存在");
    const cat = db
      .select()
      .from(categories)
      .where(and(eq(categories.id, body.categoryId), eq(categories.userId, userId), eq(categories.ledgerId, ledgerId)))
      .get();
    if (!cat) throw badRequest("CATEGORY_NOT_FOUND", "分类不存在");
    if (cat.type !== body.type) throw badRequest("CATEGORY_TYPE_MISMATCH", "分类类型与收支类型不匹配");
    if (body.endDate && body.endDate < body.startDate) throw badRequest("INVALID_DATE", "结束日期不能早于开始日期");

    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      userId,
      ledgerId,
      accountId: body.accountId,
      categoryId: body.categoryId,
      type: body.type,
      amount: body.amount,
      note: body.note ?? null,
      frequency: body.frequency,
      interval: body.interval,
      startDate: body.startDate,
      endDate: body.endDate ?? null,
      nextRunDate: body.startDate,
      lastGeneratedDate: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(recurring).values(row).run();
    const am = accountNameMap(db, userId, ledgerId);
    const cm = categoryNameMap(db, userId, ledgerId);
    return { item: toDto(row as RecurringRow, am.get(row.accountId) ?? null, cm.get(row.categoryId) ?? null) };
  });

  app.patch("/api/v1/recurring/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const ledgerId = getLedgerId(db, userId);
    const { id } = req.params as { id: string };
    const body = updateSchema.parse(req.body);
    const existing = db
      .select()
      .from(recurring)
      .where(and(eq(recurring.id, id), eq(recurring.userId, userId), eq(recurring.ledgerId, ledgerId)))
      .get();
    if (!existing) throw notFound("RECURRING_NOT_FOUND", "周期账单不存在");
    if (body.expectedUpdatedAt && existing.updatedAt !== body.expectedUpdatedAt) {
      throw conflict("CONFLICT", "周期账单已被其他端修改，请刷新后重试");
    }

    const patch: Partial<typeof recurring.$inferInsert> = {};
    if (body.accountId !== undefined) {
      const acct = db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, body.accountId), eq(accounts.userId, userId), eq(accounts.ledgerId, ledgerId)))
        .get();
      if (!acct) throw badRequest("ACCOUNT_NOT_FOUND", "账户不存在");
      patch.accountId = body.accountId;
    }
    if (body.categoryId !== undefined) {
      const cat = db
        .select()
        .from(categories)
        .where(and(eq(categories.id, body.categoryId), eq(categories.userId, userId), eq(categories.ledgerId, ledgerId)))
        .get();
      if (!cat) throw badRequest("CATEGORY_NOT_FOUND", "分类不存在");
      if (cat.type !== existing.type) throw badRequest("CATEGORY_TYPE_MISMATCH", "分类类型与收支类型不匹配");
      patch.categoryId = body.categoryId;
    }
    if (body.amount !== undefined) patch.amount = body.amount;
    if (body.note !== undefined) patch.note = body.note;
    if (body.frequency !== undefined) patch.frequency = body.frequency;
    if (body.interval !== undefined) patch.interval = body.interval;
    if (body.endDate !== undefined) patch.endDate = body.endDate;
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    if (body.startDate !== undefined) {
      patch.startDate = body.startDate;
      patch.nextRunDate = body.startDate; // 改开始日期时重置下次执行日
    }
    if (body.endDate !== undefined && body.startDate === undefined && body.endDate !== null && body.endDate < existing.startDate) {
      throw badRequest("INVALID_DATE", "结束日期不能早于开始日期");
    }
    patch.updatedAt = new Date().toISOString();
    db.update(recurring)
      .set(patch)
      .where(and(eq(recurring.id, id), eq(recurring.userId, userId), eq(recurring.ledgerId, ledgerId)))
      .run();
    const updated = db
      .select()
      .from(recurring)
      .where(and(eq(recurring.id, id), eq(recurring.userId, userId), eq(recurring.ledgerId, ledgerId)))
      .get();
    const am = accountNameMap(db, userId, ledgerId);
    const cm = categoryNameMap(db, userId, ledgerId);
    return { item: toDto(updated as RecurringRow, am.get((updated as RecurringRow).accountId) ?? null, (updated as RecurringRow).categoryId ? (cm.get((updated as RecurringRow).categoryId!) ?? null) : null) };
  });

  app.delete("/api/v1/recurring/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const ledgerId = getLedgerId(db, userId);
    const { id } = req.params as { id: string };
    const existing = db
      .select()
      .from(recurring)
      .where(and(eq(recurring.id, id), eq(recurring.userId, userId), eq(recurring.ledgerId, ledgerId)))
      .get();
    if (!existing) throw notFound("RECURRING_NOT_FOUND", "周期账单不存在");
    db.delete(recurring)
      .where(and(eq(recurring.id, id), eq(recurring.userId, userId), eq(recurring.ledgerId, ledgerId)))
      .run();
    return { ok: true };
  });
}
