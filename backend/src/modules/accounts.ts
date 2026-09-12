import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, count, eq, or } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { accounts, creditCardBills, loans, transactions } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { computeAccountBalances } from "../lib/aggregates.js";
import { getAccessibleLedger } from "../lib/access.js";
import { requireLedgerPermission } from "../lib/authorization.js";
import { convert, currencySchema } from "../lib/currency.js";
import { config } from "../config.js";
import type { Jwt } from "../auth/jwt.js";

const ACCOUNT_TYPES = ["cash", "bank", "e-wallet", "credit", "loan", "other"] as const;

const createSchema = z.object({
  name: z.string().min(1, "账户名不能为空").max(40, "账户名过长"),
  type: z.enum(ACCOUNT_TYPES).default("other"),
  // 币种统一走 currencySchema：3 位字母、归一为大写（历史缺陷：裸 z.string() 可写入 "hello"）
  currency: currencySchema.default("CNY"),
  initialBalance: z.number().int("初始余额必须为整数（分）").default(0),
  icon: z.string().max(100).optional(),
  color: z.string().max(20).optional(),
  ledgerId: z.string().optional(), // 家庭共享账本时指定；不传用当前账本
});

const updateSchema = z.object({
  name: z.string().min(1, "账户名不能为空").max(40).optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  currency: currencySchema.optional(),
  initialBalance: z.number().int("初始余额必须为整数（分）").optional(),
  icon: z.string().max(100).nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  isArchived: z.boolean().optional(),
  creditLimit: z.number().int().min(0).nullable().optional(),
  billingDay: z.number().int().min(1).max(28).nullable().optional(),
  repaymentDay: z.number().int().min(1).max(28).nullable().optional(),
  ledgerId: z.string().optional(),
  // 乐观锁：可选。若提供且与服务端当前 updatedAt 不一致则返回 409（与流水同一套约定）。
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

type AccountRow = typeof accounts.$inferSelect;

// 统计账户被哪些业务数据引用：用于禁止"已有数据还改币种"（会把历史金额重新解释成另一种币种）。
// 覆盖所有持有 accountId 的表：流水（转出/转入两侧）、贷款的还款来源与负债账户、信用卡账单。
function countAccountReferences(
  db: AppDb["db"],
  accountId: string,
): { transactions: number; loans: number; creditCardBills: number; total: number } {
  const one = (n: number | undefined) => n ?? 0;
  const tx = one(
    db
      .select({ n: count() })
      .from(transactions)
      .where(or(eq(transactions.accountId, accountId), eq(transactions.transferToAccountId, accountId)))
      .get()?.n,
  );
  const ln = one(
    db
      .select({ n: count() })
      .from(loans)
      .where(or(eq(loans.accountId, accountId), eq(loans.liabilityAccountId, accountId)))
      .get()?.n,
  );
  const cc = one(
    db.select({ n: count() }).from(creditCardBills).where(eq(creditCardBills.accountId, accountId)).get()?.n,
  );
  return { transactions: tx, loans: ln, creditCardBills: cc, total: tx + ln + cc };
}

// 负债金额统一换算为基准币返回（契约口径「本币正数」）。
// 历史缺陷：debt 返回账户原币金额，而客户端（iOS AccountsView）会把各账户 debt 直接相加
// 得到"总负债"，与已按汇率折算的总资产相减算净资产，多币种下必然算错。
function debtBaseOf(db: AppDb["db"], userId: string, row: AccountRow, balance: number): number {
  if (row.type !== "credit" && row.type !== "loan") return 0;
  return convert(db, userId, Math.max(0, -balance), row.currency, config.baseCurrency);
}

function toDto(row: AccountRow, balance: number, debt: number) {
  // 信用卡视为负债账户：balance 保持账户本位币净额口径（负数=欠款，供账户详情按自身币种展示），
  // isLiability 标记类型，debt 为该账户当前未结清欠款（已换算为基准币的正数），便于汇总"负债"。
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
    debt,
    creditLimit: row.creditLimit ?? null,
    billingDay: row.billingDay ?? null,
    repaymentDay: row.repaymentDay ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
    return {
      items: rows.map((r) => {
        const bal = balances.get(r.id) ?? r.initialBalance;
        return toDto(r, bal, debtBaseOf(db, userId, r, bal));
      }),
    };
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
      updatedAt: new Date().toISOString(),
    };
    db.insert(accounts).values(row).run();
    const bal = body.initialBalance;
    return { item: toDto(row, bal, debtBaseOf(db, userId, row as AccountRow, bal)) };
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
    const bal = balances.get(row.id) ?? row.initialBalance;
    return { item: toDto(row, bal, debtBaseOf(db, userId, row as AccountRow, bal)) };
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
    // 乐观锁：家庭共享账本下两台设备并发改同一账户时，过期方收到 409 而不是静默覆盖
    if (body.expectedUpdatedAt && existing.updatedAt !== body.expectedUpdatedAt) {
      throw conflict("CONFLICT", "账户已被其他端修改，请刷新后重试");
    }
    const patch: Partial<typeof accounts.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.type !== undefined) patch.type = body.type;
    if (body.currency !== undefined) {
      // 历史缺陷（已实测复现）：账户币种可以直接改，且不做任何前置校验，
      // 已有流水会被静默"重新解释"成另一种币种（CNY 100 → USD 100），统计随之失真。
      // 规则：只要账户已被任何业务数据引用，就禁止改币种（需改请新建账户后迁移）。
      if (body.currency !== existing.currency) {
        const refs = countAccountReferences(db, id);
        if (refs.total > 0) {
          throw badRequest(
            "ACCOUNT_CURRENCY_LOCKED",
            "该账户已存在业务数据，无法更改币种：已有流水 " +
              refs.transactions +
              " 笔、关联贷款 " +
              refs.loans +
              " 笔、信用卡账单 " +
              refs.creditCardBills +
              " 期。历史金额会被重新解释为另一种币种，请新建账户后重新记账。",
          );
        }
      }
      patch.currency = body.currency;
    }
    if (body.initialBalance !== undefined) patch.initialBalance = body.initialBalance;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.color !== undefined) patch.color = body.color;
    if (body.isArchived !== undefined) patch.isArchived = body.isArchived;
    if (body.creditLimit !== undefined) patch.creditLimit = body.creditLimit;
    if (body.billingDay !== undefined) patch.billingDay = body.billingDay;
    if (body.repaymentDay !== undefined) patch.repaymentDay = body.repaymentDay;
    patch.updatedAt = new Date().toISOString();
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
    const bal = balances.get(id) ?? (updated as AccountRow).initialBalance;
    return { item: toDto(updated as AccountRow, bal, debtBaseOf(db, userId, updated as AccountRow, bal)) };
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
      .set({ isArchived: true, updatedAt: new Date().toISOString() })
      .where(and(eq(accounts.id, id), eq(accounts.ledgerId, ledgerId)))
      .run();
    const archived = { ...existing, isArchived: true } as AccountRow;
    return { ok: true, item: toDto(archived, existing.initialBalance, debtBaseOf(db, userId, archived, existing.initialBalance)) };
  });
}
