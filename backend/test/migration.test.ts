import { test } from "node:test";
import assert from "node:assert/strict";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, copyFileSync, readdirSync } from "node:fs";
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

test("全新数据库与已有数据库（0018→0019）两条迁移路径均可用", () => {
  const repo = resolve("./migrations");
  const files = readdirSync(repo).filter((f) => f.endsWith(".sql")).sort();

  const dir = mkdtempSync(join(tmpdir(), "tally-mig-upgrade-"));
  const migDir = join(dir, "migrations");
  mkdirSync(migDir, { recursive: true });

  // 已有数据库：同时排除 0019 与 0020，只放 0001-0018 先应用，模拟线上老库
  const oldFiles = files.filter((f) => !f.startsWith("0019") && !f.startsWith("0020"));
  for (const f of oldFiles) copyFileSync(join(repo, f), join(migDir, f));
  const dbPath = join(dir, "t.db");
  const { sqlite } = createDb(dbPath);
  try {
    runMigrations(sqlite, migDir);
    const applied = sqlite.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[];
    assert.ok(applied.length >= 18, "老库应先应用 18 个迁移");
    assert.ok(applied.every((r) => !r.name.startsWith("0019") && !r.name.startsWith("0020")), "老库阶段 0019/0020 均未应用");
    assert.ok(!applied.some((r) => r.name.startsWith("0020")), "0020 尚未应用");
    // 升级前明确断言 0020 迁移未应用、loan_payment_idempotency 表不存在
    const idemTableBefore = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='loan_payment_idempotency'")
      .get();
    assert.equal(idemTableBefore, undefined, "升级前 loan_payment_idempotency 表不应存在");

    // 已有数据库升级：放入 0019 / 0020 再跑一次
    const m19 = files.find((f) => f.startsWith("0019"))!;
    copyFileSync(join(repo, m19), join(migDir, m19));
    const m20 = files.find((f) => f.startsWith("0020"))!;
    copyFileSync(join(repo, m20), join(migDir, m20));
    runMigrations(sqlite, migDir);
    const applied2 = sqlite.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[];
    assert.ok(applied2.some((r) => r.name.startsWith("0019")), "0019 应已应用");
    assert.ok(applied2.some((r) => r.name.startsWith("0020")), "0020 应已应用");

    // 验证新结构：ledgers.deleted_at 存在、预算唯一索引为 ledger 作用域
    const cols = sqlite.prepare("PRAGMA table_info(ledgers)").all() as { name: string }[];
    assert.ok(cols.some((c) => c.name === "deleted_at"), "ledgers 应有 deleted_at 列");
    const idx = sqlite.prepare("PRAGMA index_list(budgets)").all() as { name: string }[];
    const names = idx.map((i) => i.name);
    assert.ok(names.includes("uniq_budget_total"), "应有 uniq_budget_total");
    assert.ok(names.includes("uniq_budget_cat"), "应有 uniq_budget_cat");

    // 验证 0020：loan_payment_idempotency 表结构与 (actor_user_id, loan_id, idempotency_key) 唯一索引
    const idemCols = sqlite.prepare("PRAGMA table_info(loan_payment_idempotency)").all() as { name: string }[];
    for (const col of ["actor_user_id", "loan_id", "idempotency_key", "request_fingerprint", "status", "result_json", "created_at"]) {
      assert.ok(idemCols.some((c) => c.name === col), `loan_payment_idempotency 应有列 ${col}`);
    }
    const idemIdx = sqlite.prepare("PRAGMA index_list(loan_payment_idempotency)").all() as { name: string; unique: number }[];
    assert.ok(idemIdx.some((i) => i.name === "uniq_loan_pay_idem" && i.unique === 1), "应有唯一索引 uniq_loan_pay_idem");

    // 同一用户、不同 ledger、同月同分类预算可共存（不再触发旧 userId 唯一冲突）
    sqlite.prepare("PRAGMA foreign_keys = OFF").run();
    sqlite.prepare("INSERT INTO ledgers (id, user_id, name, currency, is_default, created_at, updated_at) VALUES ('L1','U1','个人','CNY',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
    sqlite.prepare("INSERT INTO ledgers (id, user_id, name, currency, is_default, created_at, updated_at) VALUES ('L2','U1','家庭','CNY',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
    sqlite.prepare("INSERT INTO budgets (id, user_id, ledger_id, year, month, category_id, amount, created_at, updated_at) VALUES ('B1','U1','L1',2026,1,'C1',100,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
    sqlite.prepare("INSERT INTO budgets (id, user_id, ledger_id, year, month, category_id, amount, created_at, updated_at) VALUES ('B2','U1','L2',2026,1,'C1',200,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run(); // 不应抛唯一冲突
    // 同 ledger 同月同分类仍应唯一
    assert.throws(() =>
      sqlite.prepare("INSERT INTO budgets (id, user_id, ledger_id, year, month, category_id, amount, created_at, updated_at) VALUES ('B3','U1','L1',2026,1,'C1',300,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run(),
    );
    sqlite.prepare("PRAGMA foreign_keys = ON").run();
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fk-off 迁移：DDL 与 schema_migrations 记录同一事务提交，记录失败时 DDL 回滚", () => {
  const dir = mkdtempSync(join(tmpdir(), "tally-mig-fkoff-"));
  const migDir = join(dir, "migrations");
  mkdirSync(migDir, { recursive: true });
  const dbPath = join(dir, "t.db");
  const { sqlite } = createDb(dbPath);
  try {
    writeFileSync(join(migDir, "0001_base.sql"), "CREATE TABLE base_table (id TEXT PRIMARY KEY);");
    // fk-off 迁移：DDL 建表 + 建一个会在记录写入时强制失败的触发器
    writeFileSync(
      join(migDir, "0002_fkoff.sql"),
      "-- mode: fk-off\n" +
        "CREATE TABLE rollback_me (id TEXT PRIMARY KEY);\n" +
        "CREATE TRIGGER block_0002 BEFORE INSERT ON schema_migrations\n" +
        "WHEN NEW.name = '0002_fkoff.sql'\n" +
        "BEGIN SELECT RAISE(ABORT, 'forced record failure'); END;\n",
    );
    assert.throws(() => runMigrations(sqlite, migDir), /forced record failure/);

    // 0001 已应用，但 0002 的记录失败 → DDL 与记录一起回滚
    const applied = sqlite.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[];
    assert.deepEqual(applied.map((r) => r.name), ["0001_base.sql"], "0002 不应被标记为已应用");
    const hasRollbackTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rollback_me'").get();
    assert.equal(hasRollbackTable, undefined, "DDL（rollback_me 表）应随记录失败一起回滚");
    const hasTrigger = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='block_0002'").get();
    assert.equal(hasTrigger, undefined, "触发器也应随事务回滚");

    // 移除触发器后重跑：迁移可正常应用
    writeFileSync(
      join(migDir, "0002_fkoff.sql"),
      "-- mode: fk-off\nCREATE TABLE rollback_me (id TEXT PRIMARY KEY);\n",
    );
    runMigrations(sqlite, migDir);
    const applied2 = sqlite.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[];
    assert.deepEqual(applied2.map((r) => r.name), ["0001_base.sql", "0002_fkoff.sql"]);
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rollback_me'").get(), "重跑后 DDL 已应用");
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
