import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, lte, or, type SQL } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { accounts, categories, transactions } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { getAccessibleLedger } from "../lib/access.js";
import { loadRelationMaps, type RelationMaps } from "../services/transactionService.js";
import { listAccountsForUser } from "../repositories/accountRepository.js";
import { listCategoriesForUser } from "../repositories/categoryRepository.js";
import {
  decodeBillBuffer,
  parseAlipay,
  parseBankPdf,
  parseWechat,
  parseWechatXlsx,
  type ParsedBill,
} from "../lib/billParser.js";
import { buildDedupKey } from "../lib/dedup.js";
import type { Jwt } from "../auth/jwt.js";

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

const commonFields = {
  amount: z.number().int("金额必须为整数（分）").positive("金额必须大于 0"),
  date: z.string().regex(dateRe, "日期格式应为 YYYY-MM-DD"),
  note: z.string().max(500, "备注过长").optional(),
  currency: z.string().default("CNY"),
  ledgerId: z.string().optional(),
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
  ledgerId: z.string().optional(),
  // 乐观锁：可选。若提供且与服务端当前 updatedAt 不一致则返回 409。
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

const billImportSchema = z
  .object({
    mode: z.enum(["raw", "items"]),
    source: z.enum(["wechat", "alipay", "bank"]).optional(),
    content: z.string().optional(),
    contentBase64: z.string().optional(),
    ledgerId: z.string().optional(),
    force: z.boolean().optional(),
    items: z
      .array(
        z.object({
          date: z.string().regex(dateRe, "日期格式应为 YYYY-MM-DD"),
          amount: z.number().int().positive(),
          type: z.enum(["income", "expense"]),
          note: z.string().max(500).nullable().optional(),
          externalId: z.string().max(100).optional(),
        }),
      )
      .optional(),
  })
  .refine(
    (v) =>
      (v.mode === "raw" && (!!v.content || !!v.contentBase64)) ||
      (v.mode === "items" && !!v.items && v.items.length > 0),
    { message: "账单参数不完整" },
  );

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
    sourceType: tx.sourceType ?? null,
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
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
    const offset = (page - 1) * limit;

    const conds: SQL[] = [eq(transactions.ledgerId, ledgerId)];
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
    const body = createSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;

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
      sourceType: "manual",
      createdAt: now,
      updatedAt: now,
    };
    db.insert(transactions).values(row).run();
    const { am, cm } = loadRelationMaps(db, userId, ledgerId);
    return { item: toDto(row as TransactionRow, am, cm) };
  });

  app.get("/api/v1/transactions/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const { id } = req.params as { id: string };
    const row = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.ledgerId, ledgerId)))
      .get();
    if (!row) throw notFound("TRANSACTION_NOT_FOUND", "流水不存在");
    const { am, cm } = loadRelationMaps(db, userId, ledgerId);
    return { item: toDto(row, am, cm) };
  });

  app.patch("/api/v1/transactions/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = updateSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    const { id } = req.params as { id: string };
    const existing = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.ledgerId, ledgerId)))
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
        .where(and(eq(accounts.id, body.accountId), eq(accounts.ledgerId, ledgerId)))
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
          .where(and(eq(categories.id, body.categoryId), eq(categories.ledgerId, ledgerId)))
          .get();
        if (!cat) throw badRequest("CATEGORY_NOT_FOUND", "分类不存在");
        if (cat.type !== existing.type) throw badRequest("CATEGORY_TYPE_MISMATCH", "分类类型与收支类型不匹配");
        patch.categoryId = body.categoryId;
      }
    }
    patch.updatedAt = new Date().toISOString();
    db.update(transactions)
      .set(patch)
      .where(and(eq(transactions.id, id), eq(transactions.ledgerId, ledgerId)))
      .run();
    const updated = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.ledgerId, ledgerId)))
      .get();
    const { am, cm } = loadRelationMaps(db, userId, ledgerId);
    return { item: toDto(updated as TransactionRow, am, cm) };
  });

  app.delete("/api/v1/transactions/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const { id } = req.params as { id: string };
    const existing = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.ledgerId, ledgerId)))
      .get();
    if (!existing) throw notFound("TRANSACTION_NOT_FOUND", "流水不存在");
    db.delete(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.ledgerId, ledgerId)))
      .run();
    return { ok: true };
  });

  app.post("/api/v1/transactions/import", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = billImportSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;

    let items: ParsedBill[];
    if (body.mode === "raw") {
      const buf = body.contentBase64 ? Buffer.from(body.contentBase64, "base64") : null;
      const content = buf ? decodeBillBuffer(buf) : (body.content ?? "");
      if (body.source === "bank") {
        if (!buf) throw badRequest("BANK_NEED_FILE", "银行账单请上传 PDF 文件");
        items = await parseBankPdf(buf);
      } else if (body.source === "wechat") {
        // 微信导出可能是 txt 或 xlsx；xlsx 文件头为 PK（zip）
        items = buf && buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b ? parseWechatXlsx(buf) : parseWechat(content);
      } else {
        items = parseAlipay(content);
      }
    } else {
      items = (body.items ?? []).map((i) => ({
        date: i.date,
        amount: i.amount,
        type: i.type,
        note: i.note ?? null,
        externalId: i.externalId ?? null,
      }));
    }
    if (items.length === 0) throw badRequest("EMPTY_BILL", "未解析到可导入的账单，请确认文件内容或来源");

    const accts = listAccountsForUser(db, userId, ledgerId);
    const defaultAccount = accts.find((a) => !a.isArchived) ?? accts[0];
    if (!defaultAccount) throw badRequest("ACCOUNT_REQUIRED", "请先创建至少一个账户再导入");

    const cats = listCategoriesForUser(db, userId, ledgerId);
    const incomeCat = cats.find((c) => c.type === "income");
    const expenseCat = cats.find((c) => c.type === "expense");

    const now = new Date().toISOString();
    const sourceType = body.mode === "raw" ? body.source! : "import";
    let imported = 0;
    const suspectedDuplicates: Array<{ dedupKey: string; existingId: string }> = [];
    for (const it of items) {
      const externalId = it.externalId ?? `imp:${it.date}:${it.amount}:${it.type}:${it.note ?? ""}`;
      const dedupKey = buildDedupKey(it.date, it.amount, it.currency ?? "CNY", it.note);
      const existing = db
        .select()
        .from(transactions)
        .where(and(eq(transactions.ledgerId, ledgerId), eq(transactions.dedupKey, dedupKey)))
        .get();
      if (existing && !body.force) {
        suspectedDuplicates.push({ dedupKey, existingId: existing.id });
        continue; // 默认跳过跨来源疑似重复
      }
      // force=true 时仍新增，但清空 dedup_key 避免唯一索引拦截
      const effectiveDedupKey = existing ? null : dedupKey;
      const row = {
        id: randomUUID(),
        userId,
        ledgerId,
        accountId: defaultAccount.id,
        categoryId: (it.type === "income" ? incomeCat : expenseCat)?.id ?? null,
        type: it.type,
        amount: it.amount,
        currency: it.currency ?? "CNY",
        note: it.note,
        date: it.date,
        transferToAccountId: null,
        recurringId: null,
        externalId,
        sourceType,
        dedupKey: effectiveDedupKey,
        linkedTransactionId: existing?.id ?? null,
        createdAt: now,
        updatedAt: now,
      };
      try {
        const r = db
          .insert(transactions)
          .values(row)
          .onConflictDoNothing({ target: [transactions.ledgerId, transactions.dedupKey] })
          .run();
        if (r.changes > 0) imported++;
      } catch {
        // 单条失败不中断整体导入
      }
    }
    const skipped = items.length - imported;
    return { imported, skipped, total: items.length, suspectedDuplicates };
  });

  app.post("/api/v1/transactions/link", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = z
      .object({ sourceId: z.string().min(1), targetId: z.string().min(1), ledgerId: z.string().optional() })
      .parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    const source = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, body.sourceId), eq(transactions.ledgerId, ledgerId)))
      .get();
    const target = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, body.targetId), eq(transactions.ledgerId, ledgerId)))
      .get();
    if (!source || !target) throw notFound("TRANSACTION_NOT_FOUND", "流水不存在");
    if (source.id === target.id) throw badRequest("INVALID_LINK", "不能关联自身");
    db.update(transactions)
      .set({ linkedTransactionId: target.id, updatedAt: new Date().toISOString() })
      .where(eq(transactions.id, source.id))
      .run();
    return { ok: true };
  });
}
