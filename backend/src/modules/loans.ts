import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { accounts, creditCardBills, loanPayments, loans, transactions } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { getAccessibleLedger } from "../lib/access.js";
import { amortizationSchedule, monthlyPayment } from "../lib/loan.js";
import { computeAccountBalances } from "../lib/aggregates.js";
import { todayStr } from "../lib/date.js";
import type { Jwt } from "../auth/jwt.js";

const createLoanSchema = z.object({
  name: z.string().min(1).max(40),
  type: z.enum(["car", "mortgage", "other"]).default("other"),
  principal: z.number().int().positive(),
  annualRate: z.number().min(0).max(100).default(0),
  termMonths: z.number().int().min(1).max(600),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  accountId: z.string().optional(),
  ledgerId: z.string().optional(),
});

const updateLoanSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  annualRate: z.number().min(0).max(100).optional(),
  accountId: z.string().optional(),
  ledgerId: z.string().optional(),
});

const payLoanSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  payFromAccountId: z.string().optional(),
  ledgerId: z.string().optional(),
});

export function registerLoanRoutes(app: FastifyInstance, deps: { db: AppDb["db"]; jwt: Jwt }) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

  function getLoan(loanId: string, ledgerId: string) {
    const row = db
      .select()
      .from(loans)
      .where(and(eq(loans.id, loanId), eq(loans.ledgerId, ledgerId)))
      .get();
    if (!row) throw notFound("LOAN_NOT_FOUND", "贷款不存在");
    return row;
  }

  app.post("/api/v1/loans", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = createLoanSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    const now = new Date().toISOString();
    const id = randomUUID();
    const payment = monthlyPayment(body.principal, body.annualRate, body.termMonths);
    db.insert(loans)
      .values({
        id,
        userId,
        ledgerId,
        name: body.name,
        type: body.type,
        principal: body.principal,
        annualRate: body.annualRate,
        termMonths: body.termMonths,
        startDate: body.startDate,
        monthlyPayment: payment,
        remainingPrincipal: body.principal,
        accountId: body.accountId ?? null,
        nextPaymentDate: body.startDate,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const schedule = amortizationSchedule(body.principal, body.annualRate, body.termMonths, body.startDate);
    for (const s of schedule) {
      db.insert(loanPayments)
        .values({
          id: randomUUID(),
          loanId: id,
          scheduledDate: s.date,
          principalPart: s.principalPart,
          interestPart: s.interestPart,
          total: s.total,
          paid: false,
        })
        .run();
    }
    return { item: { id, name: body.name, type: body.type, principal: body.principal, annualRate: body.annualRate, termMonths: body.termMonths, monthlyPayment: payment, remainingPrincipal: body.principal, startDate: body.startDate } };
  });

  app.get("/api/v1/loans", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const rows = db.select().from(loans).where(eq(loans.ledgerId, ledgerId)).all();
    return { items: rows };
  });

  app.get("/api/v1/loans/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const { id } = req.params as { id: string };
    const row = getLoan(id, ledgerId);
    const schedule = db
      .select()
      .from(loanPayments)
      .where(eq(loanPayments.loanId, id))
      .orderBy(asc(loanPayments.scheduledDate))
      .all();
    return { item: row, schedule };
  });

  app.patch("/api/v1/loans/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = updateLoanSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    const { id } = req.params as { id: string };
    const existing = getLoan(id, ledgerId);
    const patch: Partial<typeof loans.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.annualRate !== undefined) patch.annualRate = body.annualRate;
    if (body.accountId !== undefined) patch.accountId = body.accountId;
    db.update(loans).set(patch).where(eq(loans.id, id)).run();
    const updated = db.select().from(loans).where(eq(loans.id, id)).get();
    return { item: updated };
  });

  app.delete("/api/v1/loans/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const { id } = req.params as { id: string };
    getLoan(id, ledgerId);
    db.delete(loanPayments).where(eq(loanPayments.loanId, id)).run();
    db.delete(loans).where(eq(loans.id, id)).run();
    return { ok: true };
  });

  app.post("/api/v1/loans/:id/pay", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = payLoanSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    const { id } = req.params as { id: string };
    const loan = getLoan(id, ledgerId);
    const next = db
      .select()
      .from(loanPayments)
      .where(and(eq(loanPayments.loanId, id), eq(loanPayments.paid, false)))
      .orderBy(asc(loanPayments.scheduledDate))
      .get();
    if (!next) throw badRequest("LOAN_PAID_OFF", "贷款已还清");

    // 还款来源账户：优先显式指定，其次贷款绑定的账户；必须是账本内非信用卡账户。
    const payFromId = body.payFromAccountId ?? loan.accountId;
    const payFrom = payFromId
      ? db.select().from(accounts).where(and(eq(accounts.id, payFromId), eq(accounts.ledgerId, ledgerId))).get()
      : undefined;
    if (!payFrom) throw badRequest("ACCOUNT_NOT_FOUND", "请先为贷款绑定或指定还款账户（银行卡/现金）");
    if (payFrom.type === "credit") throw badRequest("INVALID_PAY_ACCOUNT", "还款账户不能是信用卡");

    const date = body.date ?? next.scheduledDate;
    const now = new Date().toISOString();

    // 全部在同一事务内完成：生成还款转账流水 + 标记期次已还 + 更新贷款余额，失败整体回滚
    db.transaction((tx) => {
      const transferId = randomUUID();
      tx.insert(transactions)
        .values({
          id: transferId,
          userId,
          ledgerId,
          accountId: payFrom.id,
          categoryId: null,
          type: "transfer",
          amount: next.total,
          currency: payFrom.currency || "CNY",
          note: `贷款还款 ${loan.name} 第${next.scheduledDate}期`,
          date,
          transferToAccountId: loan.accountId ?? null,
          sourceType: "loan-payment",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      tx.update(loanPayments).set({ paid: true }).where(eq(loanPayments.id, next.id)).run();

      const all = tx.select().from(loanPayments).where(eq(loanPayments.loanId, id)).orderBy(asc(loanPayments.scheduledDate)).all();
      const nextUnpaid = all.find((p) => !p.paid);
      const unpaidPrincipal = all.filter((p) => !p.paid).reduce((sum, p) => sum + p.principalPart, 0);
      tx.update(loans)
        .set({
          remainingPrincipal: unpaidPrincipal,
          nextPaymentDate: nextUnpaid?.scheduledDate ?? null,
          updatedAt: now,
        })
        .where(eq(loans.id, id))
        .run();
    });

    return { ok: true, paidDate: date };
  });

  app.get("/api/v1/liabilities", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const balances = computeAccountBalances(db, userId, ledgerId);
    const creditAccounts = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.ledgerId, ledgerId), eq(accounts.type, "credit")))
      .all();
    const creditCards = creditAccounts.map((a) => ({
      accountId: a.id,
      name: a.name,
      debt: Math.max(0, -(balances.get(a.id) ?? 0)),
      creditLimit: a.creditLimit ?? null,
      billingDay: a.billingDay ?? null,
      repaymentDay: a.repaymentDay ?? null,
    }));
    const loanRows = db.select().from(loans).where(eq(loans.ledgerId, ledgerId)).all();
    const loansOut = loanRows.map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      remainingPrincipal: l.remainingPrincipal,
      monthlyPayment: l.monthlyPayment,
      nextPaymentDate: l.nextPaymentDate,
    }));
    const creditBillAccounts = creditAccounts.map((a) => a.id);
    const creditBills =
      creditBillAccounts.length > 0
        ? db
            .select()
            .from(creditCardBills)
            .where(and(inArray(creditCardBills.accountId, creditBillAccounts), eq(creditCardBills.paid, false)))
            .all()
        : [];
    const totalDebt = creditCards.reduce((s, c) => s + c.debt, 0) + loansOut.reduce((s, l) => s + l.remainingPrincipal, 0);
    return { totalDebt, creditCards, loans: loansOut, creditCardBills: creditBills };
  });

  app.post("/api/v1/credit-cards/:accountId/bills", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = z
      .object({
        period: z.string().regex(/^\d{4}-\d{2}$/),
        statementBalance: z.number().int().min(0),
        minimumPayment: z.number().int().min(0).optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        ledgerId: z.string().optional(),
      })
      .parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    const { accountId } = req.params as { accountId: string };
    const acct = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.ledgerId, ledgerId), eq(accounts.type, "credit")))
      .get();
    if (!acct) throw badRequest("ACCOUNT_NOT_FOUND", "信用卡账户不存在");
    const existing = db
      .select()
      .from(creditCardBills)
      .where(and(eq(creditCardBills.accountId, accountId), eq(creditCardBills.period, body.period)))
      .get();
    if (existing) throw conflict("BILL_PERIOD_EXISTS", "该期账单已存在");
    const id = randomUUID();
    db.insert(creditCardBills)
      .values({
        id,
        accountId,
        period: body.period,
        statementBalance: body.statementBalance,
        minimumPayment: body.minimumPayment ?? 0,
        dueDate: body.dueDate ?? null,
        paid: false,
      })
      .run();
    return { item: { id, accountId, period: body.period, statementBalance: body.statementBalance, minimumPayment: body.minimumPayment ?? 0, dueDate: body.dueDate ?? null, paid: false } };
  });

  app.get("/api/v1/credit-card-bills", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const accts = db
      .select()
      .from(accounts)
      .where(eq(accounts.ledgerId, ledgerId))
      .all();
    const ids = accts.map((a) => a.id);
    const bills = ids.length > 0 ? db.select().from(creditCardBills).where(inArray(creditCardBills.accountId, ids)).all() : [];
    return { items: bills };
  });

  // 还款：必须生成一条「还款账户 → 信用卡账户」的转账流水，再标记已还。
  // 不允许只把 paid 改成 true（否则余额与流水无法追溯）。
  app.post("/api/v1/credit-card-bills/:id/pay", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = z
      .object({
        payFromAccountId: z.string().min(1, "还款账户不能为空"),
        payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        ledgerId: z.string().optional(),
      })
      .parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    const { id } = req.params as { id: string };

    const bill = db.select().from(creditCardBills).where(eq(creditCardBills.id, id)).get();
    if (!bill) throw notFound("BILL_NOT_FOUND", "账单不存在");
    const creditAcct = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, bill.accountId), eq(accounts.ledgerId, ledgerId)))
      .get();
    if (!creditAcct) throw notFound("BILL_NOT_FOUND", "账单不存在");
    if (bill.paid) throw conflict("BILL_ALREADY_PAID", "该期账单已还");

    const payFrom = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, body.payFromAccountId), eq(accounts.ledgerId, ledgerId)))
      .get();
    if (!payFrom) throw badRequest("ACCOUNT_NOT_FOUND", "还款账户不存在");
    if (payFrom.id === bill.accountId) throw badRequest("INVALID_PAY_ACCOUNT", "还款账户不能是同一张信用卡");
    if (payFrom.type === "credit") throw badRequest("INVALID_PAY_ACCOUNT", "还款账户不能是信用卡");

    const now = new Date().toISOString();
    const transferId = randomUUID();
    const payDate = body.payDate ?? todayStr();

    db.transaction((tx) => {
      const row = {
        id: transferId,
        userId,
        ledgerId,
        accountId: payFrom.id,
        categoryId: null,
        type: "transfer" as const,
        amount: bill.statementBalance,
        currency: payFrom.currency || creditAcct.currency || "CNY",
        note: `信用卡还款 ${bill.period}`,
        date: payDate,
        transferToAccountId: bill.accountId,
        sourceType: "credit-payment",
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(transactions).values(row).run();
      tx.update(creditCardBills).set({ paid: true }).where(eq(creditCardBills.id, id)).run();
    });

    return { ok: true, transactionId: transferId };
  });

  app.patch("/api/v1/credit-card-bills/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = z
      .object({
        paid: z.boolean().optional(),
        ledgerId: z.string().optional(),
      })
      .parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    const { id } = req.params as { id: string };
    const bill = db.select().from(creditCardBills).where(eq(creditCardBills.id, id)).get();
    if (!bill) throw notFound("BILL_NOT_FOUND", "账单不存在");
    // 校验该账单属于当前账本下的信用卡
    const acct = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, bill.accountId), eq(accounts.ledgerId, ledgerId)))
      .get();
    if (!acct) throw notFound("BILL_NOT_FOUND", "账单不存在");
    if (body.paid === true) {
      // 标记已还必须走 /pay 生成转账，不能只改 paid
      throw badRequest("PAY_REQUIRED", "请使用还款接口生成转账后再标记已还");
    }
    const patch: Partial<typeof creditCardBills.$inferInsert> = {};
    if (body.paid !== undefined) patch.paid = body.paid;
    db.update(creditCardBills).set(patch).where(eq(creditCardBills.id, id)).run();
    return { ok: true };
  });
}
