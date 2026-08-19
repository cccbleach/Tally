import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, lte, or, type SQL } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { accounts, categories, transactions } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { getLedgerId } from "../lib/ledger.js";
import { loadRelationMaps, type RelationMaps } from "../services/transactionService.js";
import type { Jwt } from "../auth/jwt.js";

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

const commonFields = {
  amount: z.number().int("金额必须为整数（分）").positive("金额必须大于 0"),
  date: z.string().regex(dateRe, "日期格式应为 YYYY-MM-DD"),
  note: z.string().max(500, "备注过长").optional(),
  currency: z.string().default("CNY"),
  accountId: z.string().min(1, "账户不能为空"),
};

const createSchema = z.discriminatedUnion("type", [
  z.object({ ...commonFields, type: z.literal("income"), categoryId: z.string().min(1, "分类不能为空") }),
  z.object({ ...commonFields, type: z.literal("expense"), categoryId: z.string().min(1, "分类不能为空") }),
  z.object({ ...commonFields, type: z.literal("transfer"), transferToAccountId: z.string().min(1, "目标账户不能为空") }),
]);

const updateSchema = z.object({
  amount: z.number().int().positive().optional(),
  date: z.string().regex(dateRe, "日期格式应为 YYYY-MM-DD").optional(),
  note: z.string().max(500).nullable().optional(),
  accountId: z.string().min(1).optional(),
  categoryId: z.string().min(1).nullable().optional(),
  // 乐观锁：可选。若提供且与服务端当前 updatedAt 不一致则返回 409。
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

type TransactionRow = typeof transactions.$inferSelect;

function toDto(tx: TransactionRow, am: RelationMaps["am"], cm: RelationMaps["cm"]) {
  const cat = tx.categoryId ? cm.get(tx.categoryId) : undefined;
  return {
    id: tx.id,
    accountId: tx.accountId,
    categoryId: tx.categoryId,
    type: tx.type,
    amount: tx.amount,
    currency: tx.currency,
    note: tx.note,
    date: tx.date,
    transferToAccountId: tx.transferToAccountId,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
    accountName: am.get(tx.accountId)?.name ?? null,
    categoryName: cat?.name ?? null,
    categoryIcon: cat?.icon ?? null,
    categoryColor: cat?.color ?? null,
    transferToAccountName: tx.transferToAccountId ? (am.get(tx.transferToAccountId)?.name ?? null) : null,
  };
}

export function registerTransactionRoutes(app: FastifyInstance, deps: { db: AppDb["db"]; jwt: Jwt }) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

  app.get("/api/v1/transactions", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const ledgerId = getLedgerId(db, userId);
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
    const offset = (page - 1) * limit;

    const conds: SQL[] = [eq(transactions.userId, userId), eq(transactions.ledgerId, ledgerId)];
    if (q.from) conds.push(gte(transactions.date, q.from));
    if (q.to) conds.push(lte(transactions.date, q.to));
    if (q.accountId) {
      // 转账同时按转出/转入账户检索，保证任一账户都能看到相关流水
      conds.push(or(eq(transactions.accountId, q.accountId), eq(transactions.transferToAccountId, q.accountId)) as SQL);
    }
    if (q.categoryId) conds.push(eq(transactions.categoryId, q.categoryId));
    if (q.type === "income" || q.type === "expense" || q.type === "transfer") {
      conds.push(eq(transactions.type, q.type));
    }
    const where = and(...conds);

    const total = db.select({ c: count() }).from(transactions).where(where).get()?.c ?? 0;
    const rows = db
      .select()
      .from(transactions)
      .where(where)
      .orderBy(desc(transactions.date), desc(transactions.createdAt))
      .limit(limit)
      .offset(offset)
      .all();
    const { am, cm } = loadRelationMaps(db, userId, ledgerId);
    return { items: rows.map((r) => toDto(r, am, cm)), total, page, limit };
  });

  app.post("/api/v1/transactions", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const ledgerId = getLedgerId(db, userId);
    const body = createSchema.parse(req.body);

    const account = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, body.accountId), eq(accounts.userId, userId), eq(accounts.ledgerId, ledgerId)))
      .get();
    if (!account) throw badRequest("ACCOUNT_NOT_FOUND", "账户不存在");

    let categoryId: string | null = null;
    let transferToAccountId: string | null = null;

    if (body.type === "transfer") {
      if (body.transferToAccountId === body.accountId) {
        throw badRequest("INVALID_TRANSFER", "转出与转入账户不能相同");
      }
      const toAccount = db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, body.transferToAccountId), eq(accounts.userId, userId), eq(accounts.ledgerId, ledgerId)))
        .get();
      if (!toAccount) throw badRequest("ACCOUNT_NOT_FOUND", "转入账户不存在");
      transferToAccountId = body.transferToAccountId;
    } else {
      const cat = db
        .select()
        .from(categories)
        .where(and(eq(categories.id, body.categoryId), eq(categories.userId, userId), eq(categories.ledgerId, ledgerId)))
        .get();
      if (!cat) throw badRequest("CATEGORY_NOT_FOUND", "分类不存在");
      if (cat.type !== body.type) throw badRequest("CATEGORY_TYPE_MISMATCH", "分类类型与收支类型不匹配");
      categoryId = cat.id;
    }

    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      userId,
      ledgerId,
      accountId: body.accountId,
      categoryId,
      type: body.type,
      amount: body.amount,
      currency: body.currency,
      note: body.note ?? null,
      date: body.date,
      transferToAccountId,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(transactions).values(row).run();
    const { am, cm } = loadRelationMaps(db, userId, ledgerId);
    return { item: toDto(row as TransactionRow, am, cm) };
  });

  app.get("/api/v1/transactions/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const ledgerId = getLedgerId(db, userId);
    const { id } = req.params as { id: string };
    const row = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId), eq(transactions.ledgerId, ledgerId)))
      .get();
    if (!row) throw notFound("TRANSACTION_NOT_FOUND", "流水不存在");
    const { am, cm } = loadRelationMaps(db, userId, ledgerId);
    return { item: toDto(row, am, cm) };
  });

  app.patch("/api/v1/transactions/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const ledgerId = getLedgerId(db, userId);
    const { id } = req.params as { id: string };
    const body = updateSchema.parse(req.body);
    const existing = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId), eq(transactions.ledgerId, ledgerId)))
      .get();
    if (!existing) throw notFound("TRANSACTION_NOT_FOUND", "流水不存在");
    if (body.expectedUpdatedAt && existing.updatedAt !== body.expectedUpdatedAt) {
      throw conflict("CONFLICT", "流水已被其他端修改，请刷新后重试");
    }

    const patch: Partial<typeof transactions.$inferInsert> = {};
    if (body.amount !== undefined) patch.amount = body.amount;
    if (body.date !== undefined) patch.date = body.date;
    if (body.note !== undefined) patch.note = body.note;
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
      if (body.categoryId === null) {
        patch.categoryId = null;
      } else if (existing.type !== "transfer") {
        const cat = db
          .select()
          .from(categories)
          .where(and(eq(categories.id, body.categoryId), eq(categories.userId, userId), eq(categories.ledgerId, ledgerId)))
          .get();
        if (!cat) throw badRequest("CATEGORY_NOT_FOUND", "分类不存在");
        if (cat.type !== existing.type) throw badRequest("CATEGORY_TYPE_MISMATCH", "分类类型与收支类型不匹配");
        patch.categoryId = body.categoryId;
      }
    }
    patch.updatedAt = new Date().toISOString();
    db.update(transactions)
      .set(patch)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId), eq(transactions.ledgerId, ledgerId)))
      .run();
    const updated = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId), eq(transactions.ledgerId, ledgerId)))
      .get();
    const { am, cm } = loadRelationMaps(db, userId, ledgerId);
    return { item: toDto(updated as TransactionRow, am, cm) };
  });

  app.delete("/api/v1/transactions/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const ledgerId = getLedgerId(db, userId);
    const { id } = req.params as { id: string };
    const existing = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId), eq(transactions.ledgerId, ledgerId)))
      .get();
    if (!existing) throw notFound("TRANSACTION_NOT_FOUND", "流水不存在");
    db.delete(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId), eq(transactions.ledgerId, ledgerId)))
      .run();
    return { ok: true };
  });
}
