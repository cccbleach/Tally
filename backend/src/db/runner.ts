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

    // 在单事务内执行单个迁移：失败即回滚且不标记已应用
    const apply = sqlite.transaction(() => {
      sqlite.exec(sql);
      if (hasHash) {
        sqlite
          .prepare("INSERT INTO schema_migrations (name, applied_at, hash) VALUES (?, ?, ?)")
          .run(f, new Date().toISOString(), hash);
      } else {
        sqlite
          .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
          .run(f, new Date().toISOString());
      }
    });
    apply();
  }
}
