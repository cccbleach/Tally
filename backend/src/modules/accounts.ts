import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { accounts } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { computeAccountBalances } from "../lib/aggregates.js";
import { getAccessibleLedger } from "../lib/access.js";
import { requireLedgerPermission } from "../lib/authorization.js";
import type { Jwt } from "../auth/jwt.js";

const ACCOUNT_TYPES = ["cash", "bank", "e-wallet", "credit", "loan", "other"] as const;

const createSchema = z.object({
  name: z.string().min(1, "账户名不能为空").max(40, "账户名过长"),
  type: z.enum(ACCOUNT_TYPES).default("other"),
  currency: z.string().default("CNY"),
  initialBalance: z.number().int("初始余额必须为整数（分）").default(0),
  icon: z.string().max(100).optional(),
  color: z.string().max(20).optional(),
  ledgerId: z.string().optional(), // 家庭共享账本时指定；不传用当前账本
});

const updateSchema = z.object({
  name: z.string().min(1, "账户名不能为空").max(40).optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  currency: z.string().optional(),
  initialBalance: z.number().int("初始余额必须为整数（分）").optional(),
  icon: z.string().max(100).nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  isArchived: z.boolean().optional(),
  creditLimit: z.number().int().min(0).nullable().optional(),
  billingDay: z.number().int().min(1).max(28).nullable().optional(),
  repaymentDay: z.number().int().min(1).max(28).nullable().optional(),
  ledgerId: z.string().optional(),
});

type AccountRow = typeof accounts.$inferSelect;

function toDto(row: AccountRow, balance: number) {
  // 信用卡视为负债账户：balance 保持净值口径（负数=欠款），isLiability 标记类型，
  // debt 为该账户当前未结清欠款（本币正数），便于客户端单独展示“负债”。
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    initialBalance: row.initialBalance,
    icon: row.icon,
    color: row.color,
    isArchived: row.isArchived,
    isLiability: row.type === "credit" || row.type === "loan",
    balance,
    debt: row.type === "credit" || row.type === "loan" ? Math.max(0, -balance) : 0,
    creditLimit: row.creditLimit ?? null,
    billingDay: row.billingDay ?? null,
    repaymentDay: row.repaymentDay ?? null,
    createdAt: row.createdAt,
  };
}

export function registerAccountRoutes(app: FastifyInstance, deps: { db: AppDb["db"]; jwt: Jwt }) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

  app.get("/api/v1/accounts", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const rows = db
      .select()
      .from(accounts)
      .where(eq(accounts.ledgerId, ledgerId))
      .all();
    const balances = computeAccountBalances(db, userId, ledgerId);
    return { items: rows.map((r) => toDto(r, balances.get(r.id) ?? r.initialBalance)) };
  });

  app.post("/api/v1/accounts", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = createSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    requireLedgerPermission(db, userId, ledgerId, "account:manage");
    const row = {
      id: randomUUID(),
      userId,
      ledgerId,
      name: body.name,
      type: body.type,
      currency: body.currency,
      initialBalance: body.initialBalance,
      icon: body.icon ?? null,
      color: body.color ?? null,
      isArchived: false,
      creditLimit: null,
      billingDay: null,
      repaymentDay: null,
      createdAt: new Date().toISOString(),
    };
    db.insert(accounts).values(row).run();
    return { item: toDto(row, body.initialBalance) };
  });

  app.get("/api/v1/accounts/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const { id } = req.params as { id: string };
    const row = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.ledgerId, ledgerId)))
      .get();
    if (!row) throw notFound("ACCOUNT_NOT_FOUND", "账户不存在");
    const balances = computeAccountBalances(db, userId, ledgerId);
    return { item: toDto(row, balances.get(row.id) ?? row.initialBalance) };
  });

  app.patch("/api/v1/accounts/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = updateSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
      requireLedgerPermission(db, userId, ledgerId, "account:manage");
    const { id } = req.params as { id: string };
    const existing = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.ledgerId, ledgerId)))
      .get();
    if (!existing) throw notFound("ACCOUNT_NOT_FOUND", "账户不存在");
    const patch: Partial<typeof accounts.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.type !== undefined) patch.type = body.type;
    if (body.currency !== undefined) patch.currency = body.currency;
    if (body.initialBalance !== undefined) patch.initialBalance = body.initialBalance;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.color !== undefined) patch.color = body.color;
    if (body.isArchived !== undefined) patch.isArchived = body.isArchived;
    if (body.creditLimit !== undefined) patch.creditLimit = body.creditLimit;
    if (body.billingDay !== undefined) patch.billingDay = body.billingDay;
    if (body.repaymentDay !== undefined) patch.repaymentDay = body.repaymentDay;
    db.update(accounts)
      .set(patch)
      .where(and(eq(accounts.id, id), eq(accounts.ledgerId, ledgerId)))
      .run();
    const updated = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.ledgerId, ledgerId)))
      .get();
    const balances = computeAccountBalances(db, userId, ledgerId);
    return { item: toDto(updated as AccountRow, balances.get(id) ?? (updated as AccountRow).initialBalance) };
  });

  // 删除 = 归档（软删除），保留流水关联
  app.delete("/api/v1/accounts/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
      requireLedgerPermission(db, userId, ledgerId, "account:manage");
    const { id } = req.params as { id: string };
    const existing = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.ledgerId, ledgerId)))
      .get();
    if (!existing) throw notFound("ACCOUNT_NOT_FOUND", "账户不存在");
    db.update(accounts)
      .set({ isArchived: true })
      .where(and(eq(accounts.id, id), eq(accounts.ledgerId, ledgerId)))
      .run();
    return { ok: true, item: toDto({ ...existing, isArchived: true } as AccountRow, existing.initialBalance) };
  });
}
