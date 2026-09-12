import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, lte, or, type SQL } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { accounts, categories, transactions, familyMembers, ledgers, users } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { getAccessibleLedger } from "../lib/access.js";
import { requireLedgerPermission, requireTransactionModify } from "../lib/authorization.js";
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
import { assertCurrencyCompatible, currencySchema } from "../lib/currency.js";
import { badRequest as _badRequest } from "../lib/errors.js";
import type { Jwt } from "../auth/jwt.js";

// xlsx 解析错误统一转为 400（旧版导入接口）
async function safeParseWechatXlsx(buf: Uint8Array): Promise<ParsedBill[]> {
  try {
    return await parseWechatXlsx(buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    const code = /XLSX_TOO_LARGE/.test(msg)
      ? "FILE_TOO_LARGE"
      : /XLSX_TOO_MANY_ROWS/.test(msg)
        ? "TOO_MANY_ROWS"
        : /XLSX_TOO_MANY_CELLS/.test(msg)
          ? "TOO_MANY_CELLS"
          : "PARSE_FAILED";
    throw _badRequest(code, `无法解析微信 Excel 账单：${msg}`);
  }
}

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

const commonFields = {
  amount: z.number().int("金额必须为整数（分）").positive("金额必须大于 0"),
  date: z.string().regex(dateRe, "日期格式应为 YYYY-MM-DD"),
  note: z.string().max(500, "备注过长").optional(),
  // 币种统一走 currencySchema：3 位字母、大小写归一为大写，拒绝 "hello" 这类脏值
  currency: currencySchema.default("CNY"),
  ledgerId: z.string().optional(),
  accountId: z.string().min(1, "账户不能为空"),
  // 客户端幂等键（离线写队列重放）：同一键重复提交返回首次创建的流水，不重复入账
  clientRequestId: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/, "幂等键只允许字母数字与连字符").optional(),
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

// 家庭流水需展示“记账人昵称”，不返回手机号。
// 已退出/被移除成员的历史流水仍要正确显示昵称，因此：
//   - family_members 全量（含 is_active=0）加入；
//   - 并兜底把该账本上所有流水作者（即使成员行被彻底删除）加入。
function loadUserNicknames(db: AppDb["db"], userId: string, ledgerId: string): Map<string, string> {
  const map = new Map<string, string>();
  const ledger = db.select().from(ledgers).where(eq(ledgers.id, ledgerId)).get();
  const memberIds: string[] = [];
  const authors = db
    .select({ uid: transactions.userId })
    .from(transactions)
    .where(eq(transactions.ledgerId, ledgerId))
    .all()
    .map((a) => a.uid);
  if (ledger?.familyId) {
    const members = db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.familyId, ledger.familyId))
      .all();
    memberIds.push(...members.map((m) => m.userId));
  } else {
    memberIds.push(userId);
  }
  memberIds.push(...authors);
  for (const id of [...new Set(memberIds)]) {
    const u = db.select().from(users).where(eq(users.id, id)).get();
    if (u?.nickname) map.set(id, u.nickname);
  }
  return map;
}

function toDto(
  tx: TransactionRow,
  am: RelationMaps["am"],
  cm: RelationMaps["cm"],
  um: Map<string, string>,
) {
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
    paymentGroupId: tx.paymentGroupId ?? null,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
    accountName: am.get(tx.accountId)?.name ?? null,
    categoryName: cat?.name ?? null,
    categoryIcon: cat?.icon ?? null,
    categoryColor: cat?.color ?? null,
    transferToAccountName: tx.transferToAccountId ? (am.get(tx.transferToAccountId)?.name ?? null) : null,
      recorderNickname: um.get(tx.userId) ?? null,
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
    const um = loadUserNicknames(db, userId, ledgerId);
    return { items: rows.map((r) => toDto(r, am, cm, um)), total, page, limit };
  });

  app.post("/api/v1/transactions", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = createSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    requireLedgerPermission(db, userId, ledgerId, "transaction:create");

    // 幂等重放：离线队列重试/网络重发携带同一 clientRequestId 时，直接返回首次创建的流水。
    // 并发窗口内两个请求同时走到插入时，由 uniq_tx_client_request 唯一索引兜底（见下方 catch）。
    if (body.clientRequestId) {
      const replayed = db
        .select()
        .from(transactions)
        .where(and(eq(transactions.ledgerId, ledgerId), eq(transactions.clientRequestId, body.clientRequestId)))
        .get();
      if (replayed) {
        const { am, cm } = loadRelationMaps(db, userId, ledgerId);
        const um = loadUserNicknames(db, userId, ledgerId);
        return { item: toDto(replayed, am, cm, um) };
      }
    }

    const account = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, body.accountId), eq(accounts.ledgerId, ledgerId)))
      .get();
    if (!account) throw badRequest("ACCOUNT_NOT_FOUND", "账户不存在");

    // 未实现交易级汇率换算：禁止在账户币种与流水币种不一致的场合入账，避免账实不符。
    assertCurrencyCompatible(account, body.currency);

    let categoryId: string | null = null;
    let transferToAccountId: string | null = null;

    if (body.type === "transfer") {
      if (body.transferToAccountId === body.accountId) {
        throw badRequest("INVALID_TRANSFER", "转出与转入账户不能相同");
      }
      const toAccount = db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, body.transferToAccountId), eq(accounts.ledgerId, ledgerId)))
        .get();
      if (!toAccount) throw badRequest("ACCOUNT_NOT_FOUND", "转入账户不存在");
      // 转入账户也必须与流水币种一致（与转出账户同一护栏，避免跨币种转账）。
      assertCurrencyCompatible(toAccount, body.currency);
      transferToAccountId = body.transferToAccountId;
    } else {
      const cat = db
        .select()
        .from(categories)
        .where(and(eq(categories.id, body.categoryId), eq(categories.ledgerId, ledgerId)))
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
      clientRequestId: body.clientRequestId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      db.insert(transactions).values(row).run();
    } catch (error) {
      // 并发竞态：另一个请求已用同一幂等键插入（唯一索引 uniq_tx_client_request）。
      // 重读并返回已存在的流水，保证「至多一次入账 + 调用方拿到成功」。
      const message = error instanceof Error ? error.message : "";
      if (body.clientRequestId && message.includes("uniq_tx_client_request")) {
        const winner = db
          .select()
          .from(transactions)
          .where(and(eq(transactions.ledgerId, ledgerId), eq(transactions.clientRequestId, body.clientRequestId)))
          .get();
        if (winner) {
          const { am, cm } = loadRelationMaps(db, userId, ledgerId);
          const um = loadUserNicknames(db, userId, ledgerId);
          return { item: toDto(winner, am, cm, um) };
        }
      }
      throw error;
    }
    const { am, cm } = loadRelationMaps(db, userId, ledgerId);
    const um = loadUserNicknames(db, userId, ledgerId);
    return { item: toDto(row as TransactionRow, am, cm, um) };
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
    const um = loadUserNicknames(db, userId, ledgerId);
    return { item: toDto(row, am, cm, um) };
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
    // 账本可访问 + 资源可修改分开校验（member 只能改自己的）
    requireTransactionModify(db, userId, ledgerId, existing.userId);
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
      // 历史缺陷（已实测复现）：创建时有跨币种护栏，PATCH 改 accountId 时却只校验账户归属，
      // 于是可以把一笔 CNY 流水改挂到 USD 账户（接口返回 200，账实不符）。
      // 这里复用同一护栏：流水的既有币种必须与目标账户币种一致；转账还要校验转入侧账户。
      assertCurrencyCompatible(acct, existing.currency);
      if (existing.type === "transfer" && existing.transferToAccountId === body.accountId) {
        throw badRequest("INVALID_TRANSFER", "转出与转入账户不能相同");
      }
      if (existing.type === "transfer" && existing.transferToAccountId) {
        const toAccount = db
          .select()
          .from(accounts)
          .where(and(eq(accounts.id, existing.transferToAccountId), eq(accounts.ledgerId, ledgerId)))
          .get();
        if (toAccount && existing.transferToAccountId !== body.accountId) {
          assertCurrencyCompatible(toAccount, acct.currency);
        }
      }
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
    const um = loadUserNicknames(db, userId, ledgerId);
    return { item: toDto(updated as TransactionRow, am, cm, um) };
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
    // 账本可访问 + 资源可修改分开校验（member 只能删自己的）
    requireTransactionModify(db, userId, ledgerId, existing.userId);
    db.delete(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.ledgerId, ledgerId)))
      .run();
    return { ok: true };
  });

  // 已下线旧导入流程：请使用 /api/v1/imports/jobs（暂存+预览+确认）。保留一个版本兼容（OpenAPI 中标记 deprecated）。
  // 不再继续维护两套去重逻辑。
  app.post("/api/v1/transactions/import", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = billImportSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    requireLedgerPermission(db, userId, ledgerId, "transaction:create");

    let items: ParsedBill[];
    if (body.mode === "raw") {
      const buf = body.contentBase64 ? Buffer.from(body.contentBase64, "base64") : null;
      const content = buf ? decodeBillBuffer(buf) : (body.content ?? "");
      if (body.source === "bank") {
        if (!buf) throw badRequest("BANK_NEED_FILE", "银行账单请上传 PDF 文件");
        items = await parseBankPdf(buf);
      } else if (body.source === "wechat") {
        // 微信导出可能是 txt 或 xlsx；xlsx 文件头为 PK（zip）
        items = buf && buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b ? await safeParseWechatXlsx(buf) : parseWechat(content);
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

    // items 模式无法携带币种（zod 会剥离未知字段），此前一律按 CNY 落库——
    // 若账本默认账户是 USD，会静默把 CNY 金额记成 USD。这里改为"跟随目标账户币种"。
    const effectiveCurrency = (it: { currency?: string }) => it.currency ?? defaultAccount.currency;

    // 导入落库前先做跨币种全量校验（历史缺陷：导入路径完全没有校验账户币种，
    // 外币流水会被记到本币账户并按账户币种重新解释金额）。
    // 放在任何写入之前，保证"要么整批通过、要么一条都不写"，不产生部分导入。
    // 银行 PDF/CSV 解析出的币种（如 USD）与默认账户不一致时，这里会整批拒绝。
    for (const it of items) {
      assertCurrencyCompatible(defaultAccount, effectiveCurrency(it));
    }

    const now = new Date().toISOString();
    const sourceType = body.mode === "raw" ? body.source! : "import";
    let imported = 0;
    const suspectedDuplicates: Array<{ dedupKey: string; existingId: string }> = [];
    // 写入失败明细（与"疑似重复"分开回报，避免把写失败伪装成跳过）
    const failed: Array<{ externalId: string; reason: string }> = [];
    for (const it of items) {
      const externalId = it.externalId ?? `imp:${it.date}:${it.amount}:${it.type}:${it.note ?? ""}`;
      const dedupKey = buildDedupKey(it.date, it.amount, effectiveCurrency(it), it.note);
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
        currency: effectiveCurrency(it),
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
        // 硬去重仅依靠稳定来源 ID（同账本同来源同 external_id）；dedup_key 不再硬唯一
        const r = db
          .insert(transactions)
          .values(row)
          .onConflictDoNothing({ target: [transactions.ledgerId, transactions.sourceType, transactions.externalId] })
          .run();
        if (r.changes > 0) imported++;
      } catch (e) {
        // 历史缺陷：这里曾用空 catch {} 包住 insert，FK/CHECK 等真实写入失败会被
        // 当成"跳过"静默吞掉，调用方无法区分"重复"与"写失败"。
        // 现在按原因分类：重复（onConflictDoNothing 已处理，不抛）与写入失败分开计数并回报。
        failed.push({
          externalId,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    const skipped = items.length - imported - failed.length;
    return { imported, skipped, failed, total: items.length, suspectedDuplicates };
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
    // 关联操作修改 source 流水的归属关系：需写权限，且普通 member 只能关联自己的流水
    requireTransactionModify(db, userId, ledgerId, source.userId);
    db.update(transactions)
      .set({ linkedTransactionId: target.id, updatedAt: new Date().toISOString() })
      .where(eq(transactions.id, source.id))
      .run();
    return { ok: true };
  });
}
