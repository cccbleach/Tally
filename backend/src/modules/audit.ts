import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { auditLogs } from "../db/schema.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { getAccessibleLedger } from "../lib/access.js";
import type { Jwt } from "../auth/jwt.js";

// 审计日志查询（只读）。
// 审计写入一直由各写路径通过 lib/audit.ts 完成（家庭/导入/账户等关键操作）；
// 读取接口原先恰好挂在 loans 模块里，负债域下线后独立成模块，保持「谁写的能被查到」。
export function registerAuditRoutes(app: FastifyInstance, deps: { db: AppDb["db"]; jwt: Jwt }) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

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
    return {
      items: rows.map((r) => ({
        id: r.id,
        entityType: r.entityType,
        entityId: r.entityId,
        action: r.action,
        actorUserId: r.actorUserId,
        before: r.beforeJson ? JSON.parse(r.beforeJson) : null,
        after: r.afterJson ? JSON.parse(r.afterJson) : null,
        createdAt: r.createdAt,
      })),
    };
  });
}
