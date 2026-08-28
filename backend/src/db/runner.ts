import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function ensureHashColumn(sqlite: Database.Database): boolean {
  const cols = sqlite.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "hash")) return true;
  try {
    sqlite.exec("ALTER TABLE schema_migrations ADD COLUMN hash TEXT");
    return true;
  } catch {
    return false; // 老库不支持 ALTER 时降级为不校验内容
  }
}

// 迁移文件头部的可选指令：
//   -- mode: fk-off
// 表示该迁移需要重建带外键的表。SQLite 禁止在事务内切换 PRAGMA foreign_keys，
// 因此这类迁移在“临时关闭外键”的模式下执行（DDL 本身仍是原子的），
// 结束后执行 PRAGMA foreign_key_check 校验引用完整性。
function requiresFkOff(sql: string): boolean {
  return /--\s*mode:\s*fk-off\b/.test(sql);
}

function recordMigration(
  sqlite: Database.Database,
  f: string,
  hash: string,
  hasHash: boolean,
) {
  if (hasHash) {
    sqlite
      .prepare("INSERT INTO schema_migrations (name, applied_at, hash) VALUES (?, ?, ?)")
      .run(f, new Date().toISOString(), hash);
  } else {
    sqlite
      .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
      .run(f, new Date().toISOString());
  }
}

export function runMigrations(sqlite: Database.Database, migrationsDir: string) {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const hasHash = ensureHashColumn(sqlite);
  const rows = sqlite.prepare("SELECT name, hash FROM schema_migrations").all() as { name: string; hash: string }[];
  const applied = new Map(rows.map((r) => [r.name, r.hash]));
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    const hash = sha256(sql);
    const previous = applied.get(f);

    // 已应用且内容一致 → 跳过；已应用但内容变化 → 报错，提示配置与历史不一致
    if (previous !== undefined) {
      if (hasHash && previous && previous !== hash) {
        throw new Error(
          `迁移 ${f} 已应用但内容发生变化。请勿修改已发布的迁移文件；如需变更请新增迁移。`,
        );
      }
      continue;
    }

    if (requiresFkOff(sql)) {
      // 临时关闭外键以便重建（DROP 父表时不会触发级联删除），DDL 在显式事务内执行；
      // schema_migrations 记录与 DDL 必须在同一事务内提交：任一失败都整体回滚，
      // 避免“DDL 已提交但迁移记录失败”的半迁移状态。
      sqlite.pragma("foreign_keys = OFF");
      try {
        sqlite.exec("BEGIN");
        try {
          sqlite.exec(sql);
          const issues = sqlite.pragma("foreign_key_check") as unknown[];
          if (issues.length > 0) {
            throw new Error(`迁移 ${f} 执行后外键检查失败: ${JSON.stringify(issues)}`);
          }
          recordMigration(sqlite, f, hash, hasHash);
          sqlite.exec("COMMIT");
        } catch (e) {
          sqlite.exec("ROLLBACK");
          throw e;
        }
      } finally {
        sqlite.pragma("foreign_keys = ON");
      }
      continue;
    }

    // 在单事务内执行单个迁移：失败即回滚且不标记已应用
    const apply = sqlite.transaction(() => {
      sqlite.exec(sql);
      recordMigration(sqlite, f, hash, hasHash);
    });
    apply();
  }
}
