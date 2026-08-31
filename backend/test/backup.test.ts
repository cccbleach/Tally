process.env.ALIYUN_SMS_ENABLED = "false";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { Database } from "better-sqlite3";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { users } from "../src/db/schema.js";

// 备份/恢复演练：验证「在线一致备份可被实际恢复读取」
let dir: string;
let sqlite: { backup: Database["backup"] };

before(() => {
  dir = mkdtempSync(join(tmpdir(), "tally-bk-"));
});

after(() => {
  try { (sqlite as unknown as { close: () => void })?.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

test("备份文件可恢复并读取到创建的数据", async () => {
  const dbFile = join(dir, "source.db");
  const created = createDb(dbFile);
  const { db, sqlite } = created;
  runMigrations(sqlite, resolve("./migrations"));

  // 写入一条数据
  const now = new Date().toISOString();
  db.insert(users)
    .values({
      id: "u-backup-test",
      phone: "+8613900000002",
      nickname: "备份用户",
      nicknameKey: "备份用户",
      phoneVerifiedAt: now,
      nicknameChangedAt: now,
      profileCompletedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // 创建在线一致备份文件（better-sqlite3 的 backup 为异步、返回 Promise）
  const backupFile = join(dir, "tally-backup.db");
  await sqlite.backup(backupFile);

  // 从备份恢复（重新打开备份文件即验证可读）
  const restored = createDb(backupFile);
  const row = restored.db.select().from(users).where((u) => u.phone === "+8613900000002").get();
  assert.ok(row, "恢复后的库应包含原数据");
  assert.equal(row!.nickname, "备份用户");

  // 一致性检查：恢复库能跑迁移状态查询
  const applied = (restored.db.all(`select count(*) as n from schema_migrations`) as unknown[])[0] as { n: number };
  assert.ok(applied.n >= 1, "恢复库含迁移记录");

  restored.sqlite.close();
  sqlite.close();
});