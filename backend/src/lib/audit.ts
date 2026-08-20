import { randomUUID } from "node:crypto";
import { auditLogs } from "../db/schema.js";

// 兼容 db 与事务对象（两者都具备 .insert(...).values(...).run()）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WritableDb = any;

export interface AuditEntry {
  ledgerId: string | null;
  actorUserId: string;
  entityType: string;
  entityId: string;
  action: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}

export function writeAudit(db: WritableDb, entry: AuditEntry): void {
  db.insert(auditLogs)
    .values({
      id: randomUUID(),
      ledgerId: entry.ledgerId,
      actorUserId: entry.actorUserId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      beforeJson: entry.beforeJson !== undefined ? JSON.stringify(entry.beforeJson) : null,
      afterJson: entry.afterJson !== undefined ? JSON.stringify(entry.afterJson) : null,
      createdAt: new Date().toISOString(),
    })
    .run();
}
