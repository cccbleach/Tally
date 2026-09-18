import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import {
  accounts,
  auditLogs,
  creditCardBills,
  loanPaymentIdempotency,
  loanPayments,
  loans,
  transactions,
} from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { assertCurrencyCompatible, convert, currencySchema } from "../lib/currency.js";
import { config } from "../config.js";
import { getAccessibleLedger } from "../lib/access.js";
import { requireLedgerPermission, requireTransactionModify } from "../lib/authorization.js";
import { isUniqueViolation } from "../lib/sqliteErrors.js";
import { dateStr, yearMonthStr } from "../lib/schemas.js";
import { amortizationSchedule, monthlyPayment } from "../lib/loan.js";
import { listCategoriesForUser } from "../repositories/categoryRepository.js";
import { computeAccountBalances } from "../lib/aggregates.js";
import { todayStr } from "../lib/date.js";
import { writeAudit } from "../lib/audit.js";
import type { Jwt } from "../auth/jwt.js";

const createLoanSchema = z.object({
  name: z.string().min(1).max(40),
  type: z.enum(["car", "mortgage", "other"]).default("other"),
  currency: currencySchema.default("CNY"),
  principal: z.number().int().positive(),
  annualRate: z.number().min(0).max(100).default(0),
  termMonths: z.number().int().min(1).max(600),
  startDate: dateStr(),
  accountId: z.string().optional(),           // 还款来源账户（银行卡/现金）
  liabilityAccountId: z.string().optional(),  // 已有 loan 类型负债账户；缺省则自动创建
  ledgerId: z.string().optional(),
});

const updateLoanSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  annualRate: z.number().min(0).max(100).optional(),
  accountId: z.string().optional().nullable(),
  liabilityAccountId: z.string().optional().nullable(),
  ledgerId: z.string().optional(),
});

const payLoanSchema = z.object({
  date: dateStr().optional(),
  payFromAccountId: z.string().optional(),
  ledgerId: z.string().optional(),
  // 幂等控制：客户端可显式指定要还的期次（installmentId），
  // 或提供 idempotencyKey 使同一请求的任意重放（顺序/并发）返回相同结果而不是偿还下一期。
  installmentId: z.string().optional(),
  idempotencyKey: z.string().min(1).max(64).optional(),
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
    requireLedgerPermission(db, userId, ledgerId, "transaction:create");
    const now = new Date().toISOString();
    const id = randomUUID();
    const payment = monthlyPayment(body.principal, body.annualRate, body.termMonths);
    // 退化贷款护栏：本金小于期数（或月供不足 1 分）时计划表里会出现「0 元期次」，
    // 用户能把贷款标记成已还清而本金分文未动（且 0 元流水会被 DB CHECK 拒绝）。
    if (payment < 1 || body.principal < body.termMonths) {
      throw badRequest(
        "LOAN_AMOUNT_TOO_SMALL",
        "本金过小或期数过长：每期至少要偿还 1 分，请缩短期数或提高本金",
      );
    }

    // 还款来源账户（可选）：必须是账本内非负债账户。
    if (body.accountId) {
      const payFrom = db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, body.accountId), eq(accounts.ledgerId, ledgerId)))
        .get();
      if (!payFrom) throw notFound("ACCOUNT_NOT_FOUND", "还款来源账户不存在");
      if (payFrom.type === "credit" || payFrom.type === "loan") {
        throw badRequest("INVALID_PAY_ACCOUNT", "还款来源账户不能是信用卡或贷款账户");
      }
      // 币种一致性在创建期就校验：还款路径（POST /loans/:id/pay）本来就会拒绝跨币种，
      // 但等到还款才报错会让用户先建好一笔无法偿还的贷款，因此这里提前失败。
      assertCurrencyCompatible(payFrom, body.currency);
    }

    // 负债账户创建/更新 + 贷款 INSERT + 还款计划 INSERT + 审计日志必须在同一事务内完成，
    // 任一失败整体回滚，避免出现“账户创建成功但贷款/还款计划缺失”的孤儿数据。
    let liabilityAccountId = body.liabilityAccountId ?? null;
    const schedule = amortizationSchedule(body.principal, body.annualRate, body.termMonths, body.startDate);
    db.transaction((tx) => {
      if (liabilityAccountId) {
        const liability = tx
          .select()
          .from(accounts)
          .where(and(eq(accounts.id, liabilityAccountId), eq(accounts.ledgerId, ledgerId)))
          .get();
        if (!liability) throw notFound("ACCOUNT_NOT_FOUND", "贷款负债账户不存在");
        if (liability.type !== "loan") throw badRequest("INVALID_LIABILITY_ACCOUNT", "贷款负债账户必须是 loan 类型");
        if (liability.id === body.accountId) throw badRequest("INVALID_LIABILITY_ACCOUNT", "还款来源账户不能与贷款负债账户相同");
        tx.update(accounts).set({ initialBalance: -body.principal }).where(eq(accounts.id, liability.id)).run();
      } else {
        liabilityAccountId = randomUUID();
        tx.insert(accounts)
          .values({
            id: liabilityAccountId,
            userId,
            ledgerId,
            name: `${body.name}·负债`,
            type: "loan",
            currency: body.currency,
            initialBalance: -body.principal,
            icon: null,
            color: null,
            isArchived: false,
            creditLimit: null,
            billingDay: null,
            repaymentDay: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
      tx.insert(loans)
        .values({
          id,
          userId,
          ledgerId,
          name: body.name,
          type: body.type,
          currency: body.currency,
          principal: body.principal,
          annualRate: body.annualRate,
          termMonths: body.termMonths,
          startDate: body.startDate,
          monthlyPayment: payment,
          remainingPrincipal: body.principal,
          accountId: body.accountId ?? null,
          liabilityAccountId,
          repaymentMethod: "equal_installment",
          status: "active",
          nextPaymentDate: body.startDate,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      for (let i = 0; i < schedule.length; i++) {
        const s = schedule[i]!;
        tx.insert(loanPayments)
          .values({
            id: randomUUID(),
            loanId: id,
            installmentNo: i + 1,
            dueDate: s.date,
            principalDue: s.principalPart,
            interestDue: s.interestPart,
            principalPaid: 0,
            interestPaid: 0,
            total: s.total,
            paid: false,
            paidAt: null,
            paymentTransactionId: null,
            status: "pending",
          })
          .run();
      }
      writeAudit(tx, {
        ledgerId,
        actorUserId: userId,
        entityType: "loan",
        entityId: id,
        action: "loan_create",
        afterJson: {
          name: body.name,
          type: body.type,
          currency: body.currency,
          principal: body.principal,
          annualRate: body.annualRate,
          termMonths: body.termMonths,
          liabilityAccountId,
        },
      });
    });
    return { item: { id, name: body.name, type: body.type, currency: body.currency, principal: body.principal, annualRate: body.annualRate, termMonths: body.termMonths, monthlyPayment: payment, remainingPrincipal: body.principal, startDate: body.startDate, accountId: body.accountId ?? null, liabilityAccountId } };
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
      .orderBy(asc(loanPayments.installmentNo))
      .all();
    return { item: row, schedule };
  });

  app.patch("/api/v1/loans/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = updateLoanSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    requireLedgerPermission(db, userId, ledgerId, "transaction:update");
    const { id } = req.params as { id: string };
    const loan = getLoan(id, ledgerId); // 存在性校验（不存在即 404），并取币种用于下方护栏
    const patch: Partial<typeof loans.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.annualRate !== undefined) patch.annualRate = body.annualRate;
    if (body.accountId !== undefined) {
      if (body.accountId) {
        const acct = db
          .select()
          .from(accounts)
          .where(and(eq(accounts.id, body.accountId), eq(accounts.ledgerId, ledgerId)))
          .get();
        if (!acct) throw notFound("ACCOUNT_NOT_FOUND", "还款来源账户不存在");
        if (acct.type === "credit" || acct.type === "loan") {
          throw badRequest("INVALID_PAY_ACCOUNT", "还款来源账户不能是信用卡或贷款账户");
        }
        // 币种护栏（修复已复现的绕过）：创建期校验了币种，但 PATCH 改账户原先完全不校验，
        // 于是可以把 CNY 贷款改绑到 USD 账户；此后 /loans/:id/pay 会因跨币种被拒，
        // 用户就卡在一笔无法偿还的贷款上。这里与创建期复用同一护栏。
        assertCurrencyCompatible(acct, loan.currency);
      }
      patch.accountId = body.accountId;
    }
    if (body.liabilityAccountId !== undefined) {
      if (body.liabilityAccountId) {
        const liab = db
          .select()
          .from(accounts)
          .where(and(eq(accounts.id, body.liabilityAccountId), eq(accounts.ledgerId, ledgerId)))
          .get();
        if (!liab) throw notFound("ACCOUNT_NOT_FOUND", "贷款负债账户不存在");
        if (liab.type !== "loan") throw badRequest("INVALID_LIABILITY_ACCOUNT", "贷款负债账户必须是 loan 类型");
        // 负债账户代表这笔贷款本身，币种必须与贷款一致（否则负债金额会被按账户币种重新解释）
        assertCurrencyCompatible(liab, loan.currency);
      }
      patch.liabilityAccountId = body.liabilityAccountId;
    }
    db.update(loans).set(patch).where(eq(loans.id, id)).run();
    const updated = db.select().from(loans).where(eq(loans.id, id)).get();
    return { item: updated };
  });

  app.delete("/api/v1/loans/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const { id } = req.params as { id: string };
    const loan = getLoan(id, ledgerId);
    // 删除贷款归属「修改该资源」：与流水删除同口径（owner/admin 任意，member 仅本人创建）。
    // 历史缺陷：这里只要求 transaction:update，任何成员都能删掉别人建的贷款。
    requireTransactionModify(db, userId, ledgerId, loan.userId);

    // 一次事务内完成：还款计划 → 幂等记录 → 贷款 → 归档负债账户 → 审计。
    // 历史缺陷：只删 loan_payments + loans，把 loan 类型负债账户（余额 -本金）和还款流水留在库里，
    // 于是 /stats/summary 负债归零、/accounts 仍显示一笔没有任何贷款对应的负债账户。
    // 负债账户只归档不物理删除：transactions.account_id 是 ON DELETE CASCADE，
    // 硬删会连带删掉历史还款流水（本金转账/利息支出），那是真实的资金流水，不能因为删贷款而消失。
    const liabilityAccount = loan.liabilityAccountId
      ? db.select().from(accounts).where(eq(accounts.id, loan.liabilityAccountId)).get()
      : undefined;
    const paymentCount = db.select().from(loanPayments).where(eq(loanPayments.loanId, id)).all().length;

    db.transaction((tx) => {
      tx.delete(loanPayments).where(eq(loanPayments.loanId, id)).run();
      tx.delete(loanPaymentIdempotency).where(eq(loanPaymentIdempotency.loanId, id)).run();
      tx.delete(loans).where(eq(loans.id, id)).run();
      if (liabilityAccount) {
        tx.update(accounts)
          .set({ isArchived: true, updatedAt: new Date().toISOString() })
          .where(eq(accounts.id, liabilityAccount.id))
          .run();
      }
      writeAudit(tx, {
        ledgerId,
        actorUserId: userId,
        entityType: "loan",
        entityId: id,
        action: "loan_delete",
        beforeJson: {
          name: loan.name,
          currency: loan.currency,
          remainingPrincipal: loan.remainingPrincipal,
          installments: paymentCount,
          liabilityAccountId: loan.liabilityAccountId,
        },
        afterJson: { liabilityAccountArchived: Boolean(liabilityAccount) },
      });
    });
    return { ok: true, liabilityAccountArchived: Boolean(liabilityAccount) };
  });

  // 并发认领失败（同一 (actor_user_id, loan_id, idempotency_key) 唯一索引冲突）
  // 时，说明另一请求已先提交同一幂等键 → 重读已完成结果返回。
  // 判定逻辑与流水幂等共用一份实现（lib/sqliteErrors.ts，按 err.code 而非索引名）。

  function findIdempotency(userIdArg: string, loanIdArg: string, key: string) {
    return db
      .select()
      .from(loanPaymentIdempotency)
      .where(
        and(
          eq(loanPaymentIdempotency.actorUserId, userIdArg),
          eq(loanPaymentIdempotency.loanId, loanIdArg),
          eq(loanPaymentIdempotency.idempotencyKey, key),
        ),
      )
      .get();
  }

  app.post("/api/v1/loans/:id/pay", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = payLoanSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    requireLedgerPermission(db, userId, ledgerId, "transaction:update");
    const { id } = req.params as { id: string };
    const loan = getLoan(id, ledgerId);

    // 「偿还下一期」（未指定 installmentId）必须携带 idempotencyKey：
    // 否则客户端双击（每次生成新 key）会连续偿还多期。
    if (!body.installmentId && !body.idempotencyKey) {
      throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "偿还下一期必须提供 idempotencyKey");
    }

    // 稳定指纹：仅依赖“原始请求字段”（期次 / 还款账户 / 日期 / 账本），不依赖任何会被还款改变或
    // 可变的账户状态（下一期是谁、paid 状态、贷款当前绑定的 accountId 等）。因此在鉴权取到 loan 后
    // 立即计算并查询幂等记录：命中同 key + 同指纹时直接返回已保存结果，绝不先解析目标期次、
    // 校验 paid 状态或重新校验可变账户状态。
    // 注意「偿还下一期」（未指定 installmentId）用固定标记 "next" 作为指纹，而不是动态解析出的
    // 当期次 id/日期：这样首次「偿还下一期」完成后（包括还清最后一期、贷款进入 paid_off），
    // 同一 key 的顺序重放仍命中同一指纹并原样返回首次结果，而不会因为“下一期已推进 / 已还清”
    // 而误判为 LOAN_PAID_OFF 或不同请求。
    // date 仅取请求方显式提供的日期；未提供（缺省用到期日）时记 null，避免“下一期推进导致
    // 缺省日期变化”被误判为不同请求。还款账户同样仅取请求字段，避免依赖 loan.accountId 绑定变化。
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          installment: body.installmentId ?? "next",
          payFromAccountId: body.payFromAccountId ?? null,
          date: body.date ?? null,
          ledgerId,
        }),
      )
      .digest("hex");

    // 幂等重放：若该 idempotencyKey 已处理过此贷款，直接返回上次结果
    // （不解析下一期、不校验 paid、不重新校验可变账户状态）。
    if (body.idempotencyKey) {
      const existing = findIdempotency(userId, id, body.idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint === fingerprint) {
          const res = JSON.parse(existing.resultJson) as Record<string, unknown>;
          return { ok: true, replayed: true, ...res };
        }
        throw conflict("IDEMPOTENCY_KEY_REUSED", "该 idempotencyKey 已用于其他还款请求，不能复用");
      }
    }

    // 未命中幂等记录：现在才解析目标期次。
    // 显式 installmentId 即使已还也不立即抛错 —— 先完成其余校验，最后对“无匹配幂等记录”的
    // 真正重复提交抛 INSTALLMENT_ALREADY_PAID；这样并发同 key 的同请求一定能回到首次结果。
    let next: typeof loanPayments.$inferSelect;
    let explicitAlreadyPaid = false;
    if (body.installmentId) {
      const target = db
        .select()
        .from(loanPayments)
        .where(and(eq(loanPayments.id, body.installmentId), eq(loanPayments.loanId, id)))
        .get();
      if (!target) throw notFound("INSTALLMENT_NOT_FOUND", "还款期次不存在");
      if (target.paid) explicitAlreadyPaid = true;
      next = target;
    } else {
      const n = db
        .select()
        .from(loanPayments)
        .where(and(eq(loanPayments.loanId, id), eq(loanPayments.paid, false)))
        .orderBy(asc(loanPayments.installmentNo))
        .get();
      if (!n) throw badRequest("LOAN_PAID_OFF", "贷款已还清");
      next = n;
    }

    // 还款来源账户：优先显式指定，其次贷款绑定的账户；必须是账本内非负债账户。
    const payFromId = body.payFromAccountId ?? loan.accountId;
    const payFrom = payFromId
      ? db.select().from(accounts).where(and(eq(accounts.id, payFromId), eq(accounts.ledgerId, ledgerId))).get()
      : undefined;
    if (!payFrom) throw badRequest("ACCOUNT_NOT_FOUND", "请先为贷款绑定或指定还款账户（银行卡/现金）");
    if (payFrom.type === "credit" || payFrom.type === "loan") throw badRequest("INVALID_PAY_ACCOUNT", "还款账户不能是信用卡或贷款账户");
    if (payFrom.id === loan.liabilityAccountId) throw badRequest("INVALID_PAY_ACCOUNT", "还款来源不能是贷款负债账户本身");
    if (payFrom.currency !== loan.currency) {
      throw badRequest("CURRENCY_MISMATCH", "跨币种还款暂不支持，请先开通汇率换算");
    }

    // 贷款负债账户：新流程优先用 liabilityAccountId；老数据兼容回退到 accountId。
    const transferTarget = loan.liabilityAccountId ?? loan.accountId;
    if (!transferTarget) throw badRequest("LIABILITY_ACCOUNT_REQUIRED", "贷款缺少负债账户，请先绑定");
    // 利息分类：从当前账本选支出分类（优先含“利息/贷款/还款”关键字，其次任意支出分类）。
    const expenseCats = listCategoriesForUser(db, userId, ledgerId).filter((c) => c.type === "expense");
    const interestCat = expenseCats.find((c) => /利息|贷款|房贷|还款/.test(c.name)) ?? expenseCats[0];

    const date = body.date ?? next.dueDate;

    // 走到这里说明没有匹配的幂等记录：若显式目标期次已还，则是真正的重复提交/不同请求 → 409
    if (explicitAlreadyPaid) {
      throw conflict("INSTALLMENT_ALREADY_PAID", "该期已还款，不能重复提交");
    }

    const now = new Date().toISOString();
    const paymentGroupId = randomUUID();
    // 0 元的腿不写流水：0 利率贷款的利息、或本金已还完的期次，其金额为 0。
    // 这类流水没有任何信息量，而且会被 transactions 的 CHECK (amount > 0) 直接拒绝（迁移 0024）。
    const principalTxId = next.principalDue > 0 ? randomUUID() : null;
    const interestTxId = next.interestDue > 0 ? randomUUID() : null;
    if (!principalTxId && !interestTxId) {
      // 历史退化数据（本金 < 期数，月供被取整成 0）才会走到这里：不能既标记已还又不产生流水。
      throw conflict(
        "INSTALLMENT_DEGENERATE",
        "该期应还本金与利息均为 0（贷款本金/期数配置异常），无法生成还款流水，请重建这笔贷款",
      );
    }
    const result = {
      paidDate: date,
      installment: next.installmentNo,
      installmentId: next.id,
      principalTransactionId: principalTxId,
      interestTransactionId: interestTxId,
      paymentGroupId,
    };
    const idemId = body.idempotencyKey ? randomUUID() : null;

    // 一次还款事务：幂等认领 + 本金转账 + 利息支出 + 期次条件更新 + 贷款余额 + 审计，
    // 全部在同一事务内，失败整体回滚。
    try {
      db.transaction((tx) => {
        // 1) 幂等认领（仅当提供 key）：以 UNIQUE(actor_user_id, loan_id, idempotency_key)
        //    作为数据库级并发认领。两个同 key 并发请求中只有先插入的一方成功，
        //    后到的一方命中唯一约束冲突，从而在下方 catch 中重新读取已完成结果返回。
        if (idemId) {
          tx.insert(loanPaymentIdempotency)
            .values({
              id: idemId,
              actorUserId: userId,
              loanId: id,
              idempotencyKey: body.idempotencyKey!,
              requestFingerprint: fingerprint,
              status: "completed",
              resultJson: JSON.stringify(result),
              createdAt: now,
            })
            .run();
        }

        // 2) 本金：还款来源账户 → 贷款负债账户（转账）
        if (principalTxId) {
          tx.insert(transactions)
            .values({
              id: principalTxId,
              userId,
              ledgerId,
              accountId: payFrom.id,
              categoryId: null,
              type: "transfer",
              amount: next.principalDue,
              currency: payFrom.currency || "CNY",
              note: `贷款本金还款 ${loan.name} 第${next.installmentNo}期`,
              date,
              transferToAccountId: transferTarget,
              sourceType: "loan-payment",
              paymentGroupId,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }

        // 3) 利息：还款来源账户 → 利息分类（支出）；0 利率时利息为 0，不写这条腿
        if (interestTxId) {
          tx.insert(transactions)
            .values({
              id: interestTxId,
              userId,
              ledgerId,
              accountId: payFrom.id,
              categoryId: interestCat?.id ?? null,
              type: "expense",
              amount: next.interestDue,
              currency: payFrom.currency || "CNY",
              note: `贷款利息 ${loan.name} 第${next.installmentNo}期`,
              date,
              transferToAccountId: null,
              sourceType: "loan-interest",
              paymentGroupId,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }

        // 4) 期次条件更新（WHERE paid=false）：对非幂等重复（显式重复支付、不同 key 竞态）
        //    起第二道防线，后到的请求 changes===0 直接抛 409 并回滚本事务。
        const payResult = tx
          .update(loanPayments)
          .set({
            paid: true,
            principalPaid: next.principalDue,
            interestPaid: next.interestDue,
            paidAt: now,
            paymentTransactionId: JSON.stringify([principalTxId, interestTxId].filter(Boolean)),
            status: "paid",
          })
          .where(and(eq(loanPayments.id, next.id), eq(loanPayments.paid, false)))
          .run();
        if (payResult.changes !== 1) {
          throw conflict("INSTALLMENT_ALREADY_PAID", "该期已还款，不能重复提交");
        }

        // 5) 贷款余额 & 状态
        const all = tx.select().from(loanPayments).where(eq(loanPayments.loanId, id)).orderBy(asc(loanPayments.installmentNo)).all();
        const nextUnpaid = all.find((p) => !p.paid);
        const unpaidPrincipal = all.filter((p) => !p.paid).reduce((sum, p) => sum + p.principalDue, 0);
        tx.update(loans)
          .set({
            remainingPrincipal: unpaidPrincipal,
            nextPaymentDate: nextUnpaid?.dueDate ?? null,
            status: unpaidPrincipal <= 0 ? "paid_off" : loan.status,
            updatedAt: now,
          })
          .where(eq(loans.id, id))
          .run();

        // 6) 审计
        writeAudit(tx, {
          ledgerId,
          actorUserId: userId,
          entityType: "loan",
          entityId: id,
          action: "loan_pay",
          afterJson: {
            paymentGroupId,
            transactionIds: [principalTxId, interestTxId],
            amount: next.total,
            principal: next.principalDue,
            interest: next.interestDue,
            installment: next.installmentNo,
            installmentId: next.id,
            date,
            idempotencyKey: body.idempotencyKey ?? null,
          },
        });
      });
    } catch (e) {
      // 并发冲突：唯一索引认领失败 —— 另一请求已先提交同一 key。
      // 这里重新读取已完成结果并原样返回，绝不得仅返回 INSTALLMENT_ALREADY_PAID。
      if (body.idempotencyKey && isUniqueViolation(e)) {
        const existing = findIdempotency(userId, id, body.idempotencyKey);
        if (existing) {
          if (existing.requestFingerprint === fingerprint) {
            const res = JSON.parse(existing.resultJson) as Record<string, unknown>;
            return { ok: true, replayed: true, ...res };
          }
          throw conflict("IDEMPOTENCY_KEY_REUSED", "该 idempotencyKey 已用于其他还款请求，不能复用");
        }
        throw conflict("IDEMPOTENCY_KEY_REUSED", "并发冲突但未找到已完成的幂等结果，请重试");
      }
      throw e;
    }

    return { ok: true, replayed: false, ...result };
  });

  app.get("/api/v1/liabilities", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const balances = computeAccountBalances(db, userId, ledgerId);
    // 归档账户必须排除：assetDebtSummary 不计归档账户，这里若不过滤就会出现
    // 「归档一张有欠款的信用卡后 /liabilities.totalDebt 仍显示欠款、/stats/summary.totalDebt 已归零」
    // 的负债口径分裂（下方 totalDebt 的不变量断言依赖两者一致）。
    const creditAccounts = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.ledgerId, ledgerId), eq(accounts.type, "credit"), eq(accounts.isArchived, false)))
      .all();
    const creditCards = creditAccounts.map((a) => ({
      accountId: a.id,
      name: a.name,
      currency: a.currency,
      // 基准币口径（与 docs/api.md「本币」契约、iOS 端 Money.format 的 CNY 假设一致）。
      // 历史缺陷：这里返回账户原币金额，却被直接累加进基准币 totalDebt——
      // 一张 $500 的信用卡欠款会被当成 ¥500 计入总负债。
      debt: convert(db, userId, Math.max(0, -(balances.get(a.id) ?? 0)), a.currency, config.baseCurrency),
      creditLimit: a.creditLimit ?? null,
      billingDay: a.billingDay ?? null,
      repaymentDay: a.repaymentDay ?? null,
    }));
    const loanRows = db.select().from(loans).where(eq(loans.ledgerId, ledgerId)).all();
    const loansOut = loanRows.map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      currency: l.currency,
      // 同上：remainingPrincipal / monthlyPayment 按贷款币种换算为基准币
      remainingPrincipal: convert(db, userId, l.remainingPrincipal, l.currency, config.baseCurrency),
      remainingPrincipalNative: l.remainingPrincipal,
      monthlyPayment: convert(db, userId, l.monthlyPayment, l.currency, config.baseCurrency),
      monthlyPaymentNative: l.monthlyPayment,
      nextPaymentDate: l.nextPaymentDate,
      accountId: l.accountId,
      liabilityAccountId: l.liabilityAccountId,
      status: l.status,
    }));
    const creditBillAccounts = creditAccounts.map((a) => a.id);
    const currencyByCreditAccount = new Map(creditAccounts.map((a) => [a.id, a.currency]));
    const creditBills =
      creditBillAccounts.length > 0
        ? db
            .select()
            .from(creditCardBills)
            .where(and(inArray(creditCardBills.accountId, creditBillAccounts), eq(creditCardBills.paid, false)))
            .all()
        : [];
    // 账单金额同样必须折算：客户端按 baseCurrency 格式化（docs/api.md「金额均为基准币」），
    // 历史缺陷是这里返回卡的原币金额 → 一张 $500 的账单在 ¥ 账本里显示成 ¥500。
    const creditBillsOut = creditBills.map((b) => ({
      id: b.id,
      accountId: b.accountId,
      period: b.period,
      currency: currencyByCreditAccount.get(b.accountId) ?? config.baseCurrency,
      statementBalance: convert(db, userId, b.statementBalance, currencyByCreditAccount.get(b.accountId) ?? config.baseCurrency, config.baseCurrency),
      statementBalanceNative: b.statementBalance,
      minimumPayment: convert(db, userId, b.minimumPayment, currencyByCreditAccount.get(b.accountId) ?? config.baseCurrency, config.baseCurrency),
      minimumPaymentNative: b.minimumPayment,
      dueDate: b.dueDate,
      paid: b.paid,
    }));
    // 两张表的金额都已是基准币，可直接相加（不变量：与 /stats/summary.totalDebt 必须相等）
    const totalDebt = creditCards.reduce((s, c) => s + c.debt, 0) + loansOut.reduce((s, l) => s + l.remainingPrincipal, 0);
    return { totalDebt, baseCurrency: config.baseCurrency, creditCards, loans: loansOut, creditCardBills: creditBillsOut };
  });

  app.post("/api/v1/credit-cards/:accountId/bills", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = z
      .object({
        period: yearMonthStr(),
        statementBalance: z.number().int().min(0),
        minimumPayment: z.number().int().min(0).optional(),
        dueDate: dateStr().optional(),
        ledgerId: z.string().optional(),
      })
      .parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    requireLedgerPermission(db, userId, ledgerId, "transaction:create");
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

  // 审计日志查询（账本内可见）
  app.get("/api/v1/audit-logs", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const conds = [eq(auditLogs.ledgerId, ledgerId)];
    if (q.entityType) conds.push(eq(auditLogs.entityType, q.entityType));
    if (q.entityId) conds.push(eq(auditLogs.entityId, q.entityId));
    const rows = db
      .select()
      .from(auditLogs)
      .where(and(...conds))
      .orderBy(asc(auditLogs.createdAt))
      .all();
    return { items: rows.map((r) => ({ id: r.id, entityType: r.entityType, entityId: r.entityId, action: r.action, actorUserId: r.actorUserId, before: r.beforeJson ? JSON.parse(r.beforeJson) : null, after: r.afterJson ? JSON.parse(r.afterJson) : null, createdAt: r.createdAt })) };
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
    const currencyByAccount = new Map(accts.map((a) => [a.id, a.currency]));
    const bills = ids.length > 0 ? db.select().from(creditCardBills).where(inArray(creditCardBills.accountId, ids)).all() : [];
    // 与 /liabilities 同一币种口径：对外金额一律折算基准币（原币值放 *Native），
    // 否则客户端按 baseCurrency 格式化会把 $500 显示成 ¥500。
    return {
      items: bills.map((b) => {
        const cur = currencyByAccount.get(b.accountId) ?? config.baseCurrency;
        return {
          id: b.id,
          accountId: b.accountId,
          period: b.period,
          currency: cur,
          statementBalance: convert(db, userId, b.statementBalance, cur, config.baseCurrency),
          statementBalanceNative: b.statementBalance,
          minimumPayment: convert(db, userId, b.minimumPayment, cur, config.baseCurrency),
          minimumPaymentNative: b.minimumPayment,
          dueDate: b.dueDate,
          paid: b.paid,
        };
      }),
    };
  });

  // 还款：必须生成一条「还款账户 → 信用卡账户」的转账流水，再标记已还。
  // 不允许只把 paid 改成 true（否则余额与流水无法追溯）。
  app.post("/api/v1/credit-card-bills/:id/pay", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = z
      .object({
        payFromAccountId: z.string().min(1, "还款账户不能为空"),
        payDate: dateStr().optional(),
        ledgerId: z.string().optional(),
      })
      .parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    requireLedgerPermission(db, userId, ledgerId, "transaction:update");
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
    // 与贷款还款同一口径：信用卡不能互相还，贷款负债账户也不能当还款来源——
    // 从 loan 账户转出会减少该账户余额，却不减 remainingPrincipal，破坏贷款的不变量。
    if (payFrom.type === "credit" || payFrom.type === "loan") {
      throw badRequest("INVALID_PAY_ACCOUNT", "还款账户不能是信用卡或贷款账户");
    }
    if (payFrom.currency !== creditAcct.currency) {
      throw badRequest("CURRENCY_MISMATCH", "跨币种还款暂不支持，请先开通汇率换算");
    }

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
      // 条件更新（WHERE paid=false）：并发/重复提交时 changes===0 → 409 并回滚，避免重复还款流水。
      const payResult = tx
        .update(creditCardBills)
        .set({ paid: true })
        .where(and(eq(creditCardBills.id, id), eq(creditCardBills.paid, false)))
        .run();
      if (payResult.changes !== 1) {
        throw conflict("BILL_ALREADY_PAID", "该期账单已还");
      }
      writeAudit(tx, {
        ledgerId,
        actorUserId: userId,
        entityType: "credit_card_bill",
        entityId: id,
        action: "credit_card_pay",
        afterJson: { transactionId: transferId, amount: bill.statementBalance, period: bill.period },
      });
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
    requireLedgerPermission(db, userId, ledgerId, "transaction:update");
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
    // paid 是「已生成还款转账」的派生状态，只能由 /pay 写入：
    //   - 改 true  → 必须走 /pay 生成转账，否则余额与流水无法追溯；
    //   - 改 false → 会把已还账单重新打开，再调一次 /pay 就会重复生成一笔还款转账。
    //     历史缺陷：这里只拦了 true，导致「取消已还 → 再还一次」重复扣款、信用卡变溢缴。
    // 同值提交（已还再发 true / 未还再发 false）视为幂等空操作；整包无字段按校验错误拒绝
    // （历史缺陷：set({}) 让 drizzle 抛 "No values to set" → 500）。
    if (body.paid !== undefined && body.paid !== bill.paid) {
      if (body.paid) {
        throw badRequest("PAY_REQUIRED", "请使用还款接口生成转账后再标记已还");
      }
      throw badRequest(
        "BILL_PAID_IMMUTABLE",
        "已还账单不能取消标记；如需撤销请删除对应的还款转账流水后重新还款",
      );
    }
    if (body.paid === undefined) {
      throw badRequest("NOTHING_TO_UPDATE", "没有可更新的字段：账单已还状态只能通过还款接口变更");
    }
    return { ok: true };
  });
}
