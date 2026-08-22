import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { budgets, categories } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { expenseByCategory, monthlyTotals } from "../lib/aggregates.js";
import { getAccessibleLedger } from "../lib/access.js";
import { currentYearMonth } from "../lib/date.js";
import type { Jwt } from "../auth/jwt.js";

const createSchema = z.object({
  year: z.number().int().min(2000, "年份无效").max(2100),
  month: z.number().int().min(1, "月份无效").max(12),
  categoryId: z.string().min(1).nullable().optional(),
  amount: z.number().int().min(0, "预算金额不能为负"),
  ledgerId: z.string().optional(),
});

const updateSchema = z.object({
  amount: z.number().int().min(0, "预算金额不能为负"),
  ledgerId: z.string().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

type BudgetRow = typeof budgets.$inferSelect;

function pct(spent: number, budget: number): number {
  if (budget <= 0) return 0;
  return Math.round((spent / budget) * 1000) / 10;
}

// 统一返回带 spent/percent 的预算项，供 GET/POST/PATCH 复用，保证前后端契约一致。
function budgetItem(db: AppDb["db"], userId: string, ledgerId: string, row: BudgetRow) {
  const totals = monthlyTotals(db, userId, ledgerId, row.year, row.month);
  const byCat = expenseByCategory(db, userId, ledgerId, row.year, row.month);
  const spentMap = new Map(byCat.map((c) => [c.categoryId ?? "null", c.amount]));
  const spent = row.categoryId === null ? totals.expense : (spentMap.get(row.categoryId ?? "null") ?? 0);
  return {
    id: row.id,
    year: row.year,
    month: row.month,
    categoryId: row.categoryId,
    amount: row.amount,
    spent,
    percent: pct(spent, row.amount),
    updatedAt: row.updatedAt,
  };
}

export function registerBudgetRoutes(app: FastifyInstance, deps: { db: AppDb["db"]; jwt: Jwt }) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

  app.get("/api/v1/budgets", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const cur = currentYearMonth();
    const year = Number(q.year ?? cur.year) || cur.year;
    const month = Number(q.month ?? cur.month) || cur.month;
    const rows = db
      .select()
      .from(budgets)
      .where(
        and(eq(budgets.userId, userId), eq(budgets.ledgerId, ledgerId), eq(budgets.year, year), eq(budgets.month, month)),
      )
      .all();
    const totals = monthlyTotals(db, userId, ledgerId, year, month);
    const byCat = expenseByCategory(db, userId, ledgerId, year, month);
    const spentMap = new Map(byCat.map((c) => [c.categoryId ?? "null", c.amount]));
    const items = rows.map((r) => ({
      id: r.id,
      year: r.year,
      month: r.month,
      categoryId: r.categoryId,
      amount: r.amount,
      spent: r.categoryId === null ? totals.expense : (spentMap.get(r.categoryId) ?? 0),
      percent: r.categoryId === null ? pct(totals.expense, r.amount) : pct(spentMap.get(r.categoryId) ?? 0, r.amount),
      updatedAt: r.updatedAt,
    }));
    return { year, month, items };
  });

  app.post("/api/v1/budgets", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = createSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    if (body.categoryId) {
      const cat = db
        .select()
        .from(categories)
        .where(and(eq(categories.id, body.categoryId), eq(categories.ledgerId, ledgerId)))
        .get();
      if (!cat) throw badRequest("CATEGORY_NOT_FOUND", "分类不存在");
      if (cat.type !== "expense") throw badRequest("CATEGORY_TYPE_MISMATCH", "预算仅支持支出分类");
    }
    const cond =
      body.categoryId === null || body.categoryId === undefined
        ? [
            eq(budgets.userId, userId),
            eq(budgets.ledgerId, ledgerId),
            eq(budgets.year, body.year),
            eq(budgets.month, body.month),
            isNull(budgets.categoryId),
          ]
        : [
            eq(budgets.userId, userId),
            eq(budgets.ledgerId, ledgerId),
            eq(budgets.year, body.year),
            eq(budgets.month, body.month),
            eq(budgets.categoryId, body.categoryId),
          ];
    const existing = db.select().from(budgets).where(and(...cond)).get();
    const now = new Date().toISOString();
    if (existing) {
      db.update(budgets)
        .set({ amount: body.amount, updatedAt: now })
        .where(eq(budgets.id, existing.id))
        .run();
      return { item: budgetItem(db, userId, ledgerId, { ...existing, amount: body.amount }) };
    }
    const row = {
      id: randomUUID(),
      userId,
      ledgerId,
      year: body.year,
      month: body.month,
      categoryId: body.categoryId ?? null,
      amount: body.amount,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(budgets).values(row).run();
    return { item: budgetItem(db, userId, ledgerId, row) };
  });

  app.patch("/api/v1/budgets/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = updateSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    const { id } = req.params as { id: string };
    const existing = db
      .select()
      .from(budgets)
      .where(and(eq(budgets.id, id), eq(budgets.ledgerId, ledgerId)))
      .get();
    if (!existing) throw notFound("BUDGET_NOT_FOUND", "预算不存在");
    if (body.expectedUpdatedAt && existing.updatedAt !== body.expectedUpdatedAt) {
      throw conflict("CONFLICT", "预算已被其他端修改，请刷新后重试");
    }
    db.update(budgets)
      .set({ amount: body.amount, updatedAt: new Date().toISOString() })
      .where(and(eq(budgets.id, id), eq(budgets.ledgerId, ledgerId)))
      .run();
    return { item: budgetItem(db, userId, ledgerId, { ...existing, amount: body.amount }) };
  });

  app.delete("/api/v1/budgets/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const { id } = req.params as { id: string };
    const existing = db
      .select()
      .from(budgets)
      .where(and(eq(budgets.id, id), eq(budgets.ledgerId, ledgerId)))
      .get();
    if (!existing) throw notFound("BUDGET_NOT_FOUND", "预算不存在");
    db.delete(budgets)
      .where(and(eq(budgets.id, id), eq(budgets.ledgerId, ledgerId)))
      .run();
    return { ok: true };
  });

  app.get("/api/v1/budgets/overview", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const cur = currentYearMonth();
    const year = Number(q.year ?? cur.year) || cur.year;
    const month = Number(q.month ?? cur.month) || cur.month;
    const totals = monthlyTotals(db, userId, ledgerId, year, month);
    const totalBudget = db
      .select()
      .from(budgets)
      .where(
        and(
          eq(budgets.userId, userId),
          eq(budgets.ledgerId, ledgerId),
          eq(budgets.year, year),
          eq(budgets.month, month),
          isNull(budgets.categoryId),
        ),
      )
      .get();
    const categoryBudgets = db
      .select()
      .from(budgets)
      .where(
        and(
          eq(budgets.userId, userId),
          eq(budgets.ledgerId, ledgerId),
          eq(budgets.year, year),
          eq(budgets.month, month),
          isNotNull(budgets.categoryId),
        ),
      )
      .all();
    const cats = db
      .select()
      .from(categories)
      .where(and(eq(categories.ledgerId, ledgerId)))
      .all();
    const catName = new Map(cats.map((c) => [c.id, c.name]));
    const byCat = expenseByCategory(db, userId, ledgerId, year, month);
    const spentMap = new Map(byCat.map((c) => [c.categoryId ?? "null", c.amount]));
    const items = categoryBudgets.map((b) => {
      const spent = spentMap.get(b.categoryId ?? "null") ?? 0;
      return {
        budgetId: b.id,
        categoryId: b.categoryId,
        categoryName: b.categoryId ? (catName.get(b.categoryId) ?? "未分类") : "总预算",
        budget: b.amount,
        spent,
        percent: pct(spent, b.amount),
      };
    });
    const totalBudgetAmount = totalBudget?.amount ?? 0;
    return {
      year,
      month,
      totalBudget: totalBudgetAmount,
      totalSpent: totals.expense,
      totalPercent: pct(totals.expense, totalBudgetAmount),
      items,
    };
  });
}
