import { test } from "node:test";
import assert from "node:assert/strict";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";

test("修改已应用的迁移文件会报错（内容校验）", () => {
  const dir = mkdtempSync(join(tmpdir(), "tally-mig-"));
  const migDir = join(dir, "migrations");
  mkdirSync(migDir, { recursive: true });
  const dbPath = join(dir, "t.db");
  const { sqlite } = createDb(dbPath);
  try {
    writeFileSync(join(migDir, "0001_test.sql"), "CREATE TABLE t1 (id TEXT PRIMARY KEY);");
    runMigrations(sqlite, migDir);

    // 篡改已发布的迁移文件（模拟线上被偷偷改动）
    writeFileSync(join(migDir, "0001_test.sql"), "CREATE TABLE t1 (id TEXT PRIMARY KEY, extra TEXT);");
    assert.throws(() => runMigrations(sqlite, migDir), /已应用但内容发生变化/);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移失败时不标记已应用（事务回滚）", () => {
  const dir = mkdtempSync(join(tmpdir(), "tally-mig-"));
  const migDir = join(dir, "migrations");
  mkdirSync(migDir, { recursive: true });
  const dbPath = join(dir, "t.db");
  writeFileSync(join(migDir, "0001_ok.sql"), "CREATE TABLE a (id TEXT PRIMARY KEY);");
  writeFileSync(join(migDir, "0002_bad.sql"), "CREATE TABLE a (id TEXT PRIMARY KEY);");
  const { sqlite } = createDb(dbPath);
  try {
    assert.throws(() => runMigrations(sqlite, migDir));
    const row = sqlite.prepare("SELECT name FROM schema_migrations WHERE name='0002_bad.sql'").get();
    assert.equal(row, undefined, "失败迁移不应被标记为已应用");
    // 修正后重跑可正常应用
    writeFileSync(join(migDir, "0002_bad.sql"), "CREATE TABLE b (id TEXT PRIMARY KEY);");
    runMigrations(sqlite, migDir);
    const applied = sqlite.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[];
    assert.deepEqual(applied.map((r) => r.name), ["0001_ok.sql", "0002_bad.sql"]);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
