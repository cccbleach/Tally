import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { importItems, importJobs, transactions } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { dateStr } from "../lib/schemas.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { getAccessibleLedger } from "../lib/access.js";
import { requireLedgerPermission } from "../lib/authorization.js";
import { buildDedupKey, normalizeMerchant } from "../lib/dedup.js";
import { writeAudit } from "../lib/audit.js";
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
import type { Jwt } from "../auth/jwt.js";
import { parseBillFile } from "../lib/billFile.js";

// xlsx 解析错误统一转为 400，避免把内部解析异常暴露为 500。
async function safeParseWechatXlsx(buf: Uint8Array): Promise<import("../lib/billParser.js").ParsedBill[]> {
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
    throw badRequest(code, `无法解析微信 Excel 账单：${msg}`);
  }
}

const createJobSchema = z.object({
  mode: z.enum(["items", "raw"]),
  source: z.enum(["wechat", "alipay", "bank"]).optional(),
  items: z
    .array(
      z.object({
        date: dateStr(),
        amount: z.number().int().positive(),
        type: z.enum(["income", "expense"]),
        note: z.string().nullable().optional(),
        externalId: z.string().nullable().optional(),
      }),
    )
    .optional(),
  content: z.string().optional(),
  contentBase64: z.string().optional(),
  filename: z.string().optional(),
  ledgerId: z.string().optional(),
});

const patchItemSchema = z.object({
  decision: z.enum(["accept", "skip"]).optional(),
  accountId: z.string().optional(),
  categoryId: z.string().optional(),
}).refine((v) => v.decision !== undefined || v.accountId !== undefined || v.categoryId !== undefined, {
  message: "至少提供一项变更",
});

function fileHashOf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function createStagedJob(
  db: AppDb["db"],
  opts: { userId: string; ledgerId: string; items: ParsedBill[]; source: string; filename: string | null; fileHash: string | null },
) {
  const { userId, ledgerId, items, source, filename, fileHash } = opts;
  if (items.length === 0) throw badRequest("EMPTY_BILL", "未解析到可导入的账单，请确认文件内容或来源");
  if (items.length > 5000) throw badRequest("TOO_MANY_ITEMS", "单次最多导入 5000 条");

  const accts = listAccountsForUser(db, userId, ledgerId);
  const defaultAccount = accts.find((a) => !a.isArchived);
  if (!defaultAccount) throw badRequest("ACCOUNT_REQUIRED", "请先创建至少一个账户再导入");
  // 注意：暂存阶段不决定分类（提交时才按收支类型匹配），因此这里不查分类

  const now = new Date().toISOString();
  const jobId = randomUUID();
  // 暂存要么整体成功、要么不留任何 job/明细（历史行为是逐条 insert，失败会留下半成品 job）
  const staged = db.transaction((tx) => {
    tx.insert(importJobs)
      .values({
        id: jobId,
        ledgerId,
        userId,
        source,
        filename,
        fileHash,
        status: "staged",
        totalCount: items.length,
        importedCount: 0,
        skippedCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

  // 任务内去重：同一文件里出现多条相同外部 ID 或相同软指纹时，后续条目标记为重复
  const seenExternal = new Set<string>();
  const seenDedup = new Set<string>();
  for (const it of items) {
    const externalId = it.externalId ?? `imp:${it.date}:${it.amount}:${it.type}:${it.note ?? ""}`;
    const dedupKey = buildDedupKey(it.date, it.amount, it.note);
    const merchant = normalizeMerchant(it.note);
    // 硬去重：同一账本、同一来源、同一外部 ID（稳定来源 ID，不依赖启发式指纹）
    const hard = seenExternal.has(externalId)
      ? { id: null }
      : tx
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.ledgerId, ledgerId),
              eq(transactions.sourceType, source),
              eq(transactions.externalId, externalId),
            ),
          )
          .get();
    // 软去重：启发式指纹（日期/金额/币种/规范化商家），不作为硬唯一
    const soft =
      hard || seenDedup.has(dedupKey)
        ? { id: null }
        : tx
            .select()
            .from(transactions)
            .where(and(eq(transactions.ledgerId, ledgerId), eq(transactions.dedupKey, dedupKey)))
            .get();
    const existing = hard ?? soft;
    const status = existing ? "duplicate" : "new";
    const score = existing ? (hard ? 100 : 70) : 0;
    seenExternal.add(externalId);
    seenDedup.add(dedupKey);
    tx.insert(importItems)
      .values({
        id: randomUUID(),
        jobId,
        externalId,
        occurredAt: it.date,
        type: it.type,
        amount: it.amount,
        merchant: merchant || null,
        rawDescription: it.note,
        dedupKey,
        source,
        duplicateStatus: status,
        duplicateScore: score,
        matchedTransactionId: existing?.id ?? null,
        decision: status === "duplicate" ? "skip" : "accept",
        createdAt: now,
      })
      .run();
  }
  });
  void staged;
  return summarize(db, jobId);
}

export function registerImportRoutes(app: FastifyInstance, deps: { db: AppDb["db"]; jwt: Jwt }) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

  // 创建导入暂存任务：解析 + 去重判定，但不直接写正式流水
  app.post("/api/v1/imports/jobs", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = createJobSchema.parse(req.body);
    const ledgerId = getAccessibleLedger(db, userId, body.ledgerId).id;
    requireLedgerPermission(db, userId, ledgerId, "transaction:create");

    let items: ParsedBill[];
    let rawBuffer: Buffer | null = null;
    let source = body.source ?? "items";
    if (body.mode === "raw") {
      if (!body.source) throw badRequest("SOURCE_REQUIRED", "请指定账单来源");
      source = body.source;
      const buf = body.contentBase64 ? Buffer.from(body.contentBase64, "base64") : null;
      rawBuffer = buf;
      const content = buf ? decodeBillBuffer(buf) : (body.content ?? "");
      if (body.source === "bank") {
        if (!buf) throw badRequest("BANK_NEED_FILE", "银行账单请上传 PDF 文件");
        items = await parseBankPdf(buf);
      } else if (body.source === "wechat") {
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
    if (items.length > 5000) throw badRequest("TOO_MANY_ITEMS", "单次最多导入 5000 条");
    const counts = await createStagedJob(db, {
      userId,
      ledgerId,
      items,
      source,
      filename: body.filename ?? null,
      fileHash: rawBuffer ? fileHashOf(rawBuffer) : null,
    });
    return { item: counts.job, counts: counts.counts };
  });

  // multipart 文件上传：真正的文件上传（非 JSON base64），含大小/扩展名校验与 SHA-256
  app.post("/api/v1/imports/jobs/upload", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const data = await req.file();
    if (!data) throw badRequest("FILE_REQUIRED", "请上传账单文件");
    const buf = await data.toBuffer();
    const MAX_SIZE = 20 * 1024 * 1024;
    if (buf.length > MAX_SIZE) throw badRequest("FILE_TOO_LARGE", "文件不能超过 20MB");
    if (buf.length === 0) throw badRequest("FILE_EMPTY", "文件为空");

    const fieldSource = (data.fields?.source as { value?: string } | undefined)?.value;
    const source = z.enum(["auto", "wechat", "alipay", "bank"]).optional().parse(
      fieldSource || (req.query as Record<string, string | undefined>).source,
    );

    const ledgerId = getAccessibleLedger(db, userId, (req.query as Record<string, string | undefined>).ledgerId).id;
    requireLedgerPermission(db, userId, ledgerId, "transaction:create");

    const parsed = await parseBillFile(buf, data.filename ?? "", source);

    const counts = await createStagedJob(db, {
      userId,
      ledgerId,
      items: parsed.items,
      source: parsed.source,
      filename: data.filename ?? null,
      fileHash: fileHashOf(buf),
    });
    return { item: counts.job, counts: counts.counts };
  });

  // 列出当前账本的导入任务
  app.get("/api/v1/imports/jobs", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const rows = db
      .select()
      .from(importJobs)
      .where(eq(importJobs.ledgerId, ledgerId))
      .orderBy(desc(importJobs.createdAt))
      .all();
    return { items: rows };
  });

  // 查看任务详情 + 明细项
  app.get("/api/v1/imports/jobs/:id", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const { id } = req.params as { id: string };
    const job = db.select().from(importJobs).where(eq(importJobs.id, id)).get();
    if (!job || job.ledgerId !== ledgerId) throw notFound("IMPORT_JOB_NOT_FOUND", "导入任务不存在");
    const items = db.select().from(importItems).where(eq(importItems.jobId, id)).orderBy(asc(importItems.createdAt)).all();
    return { job, items };
  });

  // 逐条决定：accept / skip（重复项可强制改为 accept 保留）
  app.patch("/api/v1/imports/items/:itemId", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const body = patchItemSchema.parse(req.body);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    requireLedgerPermission(db, userId, ledgerId, "transaction:create");
    const { itemId } = req.params as { itemId: string };
    const item = db.select().from(importItems).where(eq(importItems.id, itemId)).get();
    if (!item) throw notFound("IMPORT_ITEM_NOT_FOUND", "明细项不存在");
    const job = db.select().from(importJobs).where(eq(importJobs.id, item.jobId)).get();
    if (!job || job.ledgerId !== ledgerId || job.status !== "staged") throw conflict("IMPORT_NOT_STAGED", "任务不可修改");
    const patch: Partial<typeof importItems.$inferInsert> = { createdAt: item.createdAt };
    if (body.decision !== undefined) patch.decision = body.decision;
    if (body.accountId !== undefined) {
      const acct = listAccountsForUser(db, userId, ledgerId).find((a) => a.id === body.accountId);
      if (!acct) throw notFound("ACCOUNT_NOT_FOUND", "账户不存在");
      patch.accountId = body.accountId;
    }
    if (body.categoryId !== undefined) {
      const cat = listCategoriesForUser(db, userId, ledgerId).find((c) => c.id === body.categoryId);
      if (!cat) throw notFound("CATEGORY_NOT_FOUND", "分类不存在");
      patch.categoryId = body.categoryId;
    }
    db.update(importItems).set(patch).where(eq(importItems.id, itemId)).run();
    return { ok: true };
  });

  // 提交：把 accept 且非重复的明细批量写入正式流水，事务化；重复项默认不写
  app.post("/api/v1/imports/jobs/:id/commit", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    requireLedgerPermission(db, userId, ledgerId, "transaction:create");
    const { id } = req.params as { id: string };
    const job = db.select().from(importJobs).where(eq(importJobs.id, id)).get();
    if (!job || job.ledgerId !== ledgerId) throw notFound("IMPORT_JOB_NOT_FOUND", "导入任务不存在");
    if (job.status !== "staged") throw conflict("IMPORT_NOT_STAGED", "任务已提交或已失败");

    const accts = listAccountsForUser(db, userId, ledgerId);
    const defaultAccount = accts.find((a) => !a.isArchived) ?? accts[0];
    if (!defaultAccount) throw badRequest("ACCOUNT_REQUIRED", "请先创建至少一个账户");
    const cats = listCategoriesForUser(db, userId, ledgerId);
    const incomeCat = cats.find((c) => c.type === "income");
    const expenseCat = cats.find((c) => c.type === "expense");

    const items = db.select().from(importItems).where(eq(importItems.jobId, id)).all();
    if (items.length === 0) throw badRequest("EMPTY_IMPORT", "任务没有明细项");

    // 明细指定的账户可在暂存后被 PATCH 改过，因此按"最终归属账户"再校验一次存在性，
    // 且在任何写入之前完成，保证不会产生部分提交。
    const accountsById = new Map(accts.map((a) => [a.id, a]));
    for (const it of items) {
      if (it.decision !== "accept") continue;
      const accountId = it.accountId ?? defaultAccount.id;
      if (!accountsById.get(accountId)) throw badRequest("ACCOUNT_NOT_FOUND", "明细指定的账户不存在或不在当前账本");
    }

    const now = new Date().toISOString();
    let imported = 0;
    let skipped = 0;
    db.transaction((tx) => {
        for (const it of items) {
          if (it.decision !== "accept") continue;
          const forced = it.duplicateStatus === "duplicate" || it.duplicateStatus === "suspected";
          const accountId = it.accountId ?? defaultAccount.id;
          const categoryId = it.categoryId ?? (it.type === "income" ? incomeCat : expenseCat)?.id ?? null;
          const row = {
            id: randomUUID(),
            userId,
            ledgerId,
            accountId,
            categoryId,
            type: it.type,
            amount: it.amount,
            note: it.rawDescription,
            date: it.occurredAt,
            transferToAccountId: null,
            recurringId: null,
            externalId: it.externalId,
            sourceType: it.source ?? job.source,
            dedupKey: it.dedupKey,
            linkedTransactionId: forced ? it.matchedTransactionId : null,
            createdAt: now,
            updatedAt: now,
          };
          try {
            tx.insert(transactions).values(row).run();
          } catch {
            // 同账本同来源同外部 ID 的硬去重冲突：明确报错而非静默跳过/丢弃
            throw conflict(
              "IMPORT_HARD_DUPLICATE",
              `第 ${it.externalId || it.id} 条与已存在流水来源冲突，请改为 skip 或重新确认`,
            );
          }
          if (forced) {
            writeAudit(tx, {
              ledgerId,
              actorUserId: userId,
              entityType: "import_item",
              entityId: it.id,
              action: "import_forced_accept",
              afterJson: { matchedTransactionId: it.matchedTransactionId, duplicateStatus: it.duplicateStatus, decision: it.decision },
            });
          }
          imported++;
        }
      skipped = items.length - imported;
      tx.update(importJobs)
        .set({ status: "committed", importedCount: imported, skippedCount: skipped, updatedAt: now })
        .where(eq(importJobs.id, id))
        .run();
      writeAudit(tx, {
        ledgerId,
        actorUserId: userId,
        entityType: "import_job",
        entityId: id,
        action: "import_commit",
        afterJson: { imported, skipped, total: items.length },
      });
    });
    return { ok: true, imported, skipped, total: items.length };
  });
}


async function summarize(db: AppDb["db"], jobId: string) {
  const job = db.select().from(importJobs).where(eq(importJobs.id, jobId)).get()!;
  const items = db.select().from(importItems).where(eq(importItems.jobId, jobId)).all();
  return {
    job,
    counts: {
      total: items.length,
      newItem: items.filter((i) => i.duplicateStatus === "new").length,
      duplicate: items.filter((i) => i.duplicateStatus === "duplicate").length,
      accepted: items.filter((i) => i.decision === "accept").length,
    },
  };
}
