process.env.ALIYUN_SMS_ENABLED = "false";
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

test("全新数据库与已有数据库（0001-0018 老库 → 0022）两条迁移路径均可用", () => {
  const repo = resolve("./migrations");
  const files = readdirSync(repo).filter((f) => f.endsWith(".sql")).sort();

  const dir = mkdtempSync(join(tmpdir(), "tally-mig-upgrade-"));
  const migDir = join(dir, "migrations");
  mkdirSync(migDir, { recursive: true });

  // 已有数据库：只放 0001-0018 先应用，模拟线上老库（0019/0020/0021/0022 之后升级）
  const oldFiles = files.filter((f) => f < "0019");
  for (const f of oldFiles) copyFileSync(join(repo, f), join(migDir, f));
  const dbPath = join(dir, "t.db");
  const { sqlite } = createDb(dbPath);
  try {
    runMigrations(sqlite, migDir);
    const applied = sqlite.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[];
    assert.ok(applied.length >= 18, "老库应先应用 18 个迁移");
    assert.ok(
      applied.every((r) => !/^00(19|20|21|22)/.test(r.name)),
      "老库阶段 0019/0020/0021/0022 均未应用",
    );

    // 升级前断言 0020/0021/0022 均未应用、相关表不存在
    const idemTableBefore = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='loan_payment_idempotency'")
      .get();
    assert.equal(idemTableBefore, undefined, "升级前 loan_payment_idempotency 表不应存在");
    const ticketTableBefore = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_tickets'")
      .get();
    assert.equal(ticketTableBefore, undefined, "升级前 onboarding_tickets 表不应存在");

    // 老库先写入旧结构用户（手机号 + 默认“用户”昵称），验证 0021 迁移质量
    const now = "2026-01-01T00:00:00Z";
    sqlite.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('U1','13800000001','x','小明',?,?)").run(now, now);
    sqlite.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('U2','13900000002','x','用户',?,?)").run(now, now);
    sqlite.prepare("INSERT INTO auth_sessions (id,user_id,refresh_token_hash,expires_at,last_used_at,created_at) VALUES ('S1','U1','H1','2030-01-01T00:00:00Z',?,?)").run(now, now);

    // 已有数据库升级：放入 0019/0020/0021/0022 再跑一次
    for (const f of files.filter((f) => f >= "0019")) copyFileSync(join(repo, f), join(migDir, f));
    runMigrations(sqlite, migDir);
    const applied2 = sqlite.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[];
    for (const p of ["0019", "0020", "0021", "0022"]) {
      assert.ok(applied2.some((r) => r.name.startsWith(p)), p + " 应已应用");
    }

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

    // 验证 0021：users 身份字段 + 迁移质量（老“用户”不迁移为公开昵称）
    const userCols = sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    for (const col of ["id", "phone", "nickname", "nickname_key", "phone_verified_at", "nickname_changed_at", "profile_completed_at"]) {
      assert.ok(userCols.some((c) => c.name === col), "users 应有列 " + col);
    }
    const u1 = sqlite.prepare("SELECT * FROM users WHERE id='U1'").get() as { phone: string; nickname: string; profile_completed_at: string | null };
    assert.equal(u1.phone, "+8613800000001", "旧手机号应迁移为 +86 E.164");
    assert.equal(u1.nickname, "小明", "真实 display_name 应迁移为公开昵称");
    assert.ok(u1.profile_completed_at, "真实昵称账号应标记完成");
    const u2 = sqlite.prepare("SELECT * FROM users WHERE id='U2'").get() as { nickname: string | null; profile_completed_at: string | null };
    assert.equal(u2.nickname, null, "旧“用户”昵称不迁移为公开昵称");
    assert.equal(u2.profile_completed_at, null, "旧“用户”账号 profile_completed_at 应为空（下次必须完成昵称设置）");

    // 升级应予吊销旧会话（S1 在升级前已存在）
    const sess = sqlite.prepare("SELECT revoked_at FROM auth_sessions WHERE id='S1'").get() as { revoked_at: string | null };
    assert.ok(sess.revoked_at, "升级后旧会话应被吊销");

    // onboarding_tickets / nickname_history 表存在
    for (const t of ["onboarding_tickets", "nickname_history"]) {
      const tbl = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='" + t + "'").get();
      assert.ok(tbl, t + " 表应存在");
    }

    // 验证 0022：单家庭约束索引 + 邀请结构
    const fmIdx = sqlite.prepare("PRAGMA index_list(family_members)").all() as { name: string; unique: number }[];
    assert.ok(fmIdx.some((i) => i.name === "uniq_family_single_active" && i.unique === 1), "应有 uniq_family_single_active");
    const ledIdx = sqlite.prepare("PRAGMA index_list(ledgers)").all() as { name: string; unique: number }[];
    assert.ok(ledIdx.some((i) => i.name === "uniq_family_active_ledger" && i.unique === 1), "应有 uniq_family_active_ledger");
    const invCols = sqlite.prepare("PRAGMA table_info(family_invitations)").all() as { name: string }[];
    assert.ok(invCols.some((c) => c.name === "target_user_id"), "family_invitations 应有 target_user_id");
    const invIdx = sqlite.prepare("PRAGMA index_list(family_invitations)").all() as { name: string; unique: number }[];
    assert.ok(invIdx.some((i) => i.name === "uniq_family_invite_pending" && i.unique === 1), "应有 uniq_family_invite_pending");

    // 外键检查无误
    const fk = sqlite.prepare("PRAGMA foreign_key_check").all();
    assert.deepEqual(fk, [], "升级后外键检查应无误");

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

// 回归：0016 重建 transactions 时漏抄了 0005 的 CHECK 约束，且此后 21 个迁移都没补回，
// 实际库里「金额必须为正、类型必须合法」只剩应用层 zod 一道（实测 .schema 无任何 CHECK）。
// 0024 第三次重建补回：升级保留数据与索引，同时非法历史行必须阻断迁移而不是被静默吞掉。
test("迁移 0024：补回 transactions 的 CHECK 约束，升级保留数据/索引，非法历史行阻断迁移", () => {
  const repo = resolve("./migrations");
  const files = readdirSync(repo).filter((f) => f.endsWith(".sql")).sort();
  const dir = mkdtempSync(join(tmpdir(), "tally-mig-check-restore-"));
  const migDir = join(dir, "migrations");
  mkdirSync(migDir, { recursive: true });
  const { sqlite } = createDb(join(dir, "t.db"));
  const seedParents = () => {
    sqlite.prepare("INSERT INTO users (id, phone, created_at, updated_at) VALUES (?,?,?,?)").run("U1", "+8613800000001", "x", "x");
    sqlite.prepare("INSERT INTO ledgers (id, user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("L1", "U1", "L", "x", "x");
    sqlite.prepare("INSERT INTO accounts (id, user_id, name, ledger_id, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("A1", "U1", "A", "L1", "x", "x");
  };
  const insertTx = (id: string, type: string, amount: number) =>
    sqlite
      .prepare("INSERT INTO transactions (id,user_id,ledger_id,account_id,type,amount,currency,date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, "U1", "L1", "A1", type, amount, "CNY", "2026-01-01", "x", "x");
  const txIndexNames = () =>
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='transactions' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((r) => r.name);

  try {
    // 老库阶段：只应用到 0023
    for (const f of files.filter((f) => f < "0024")) copyFileSync(join(repo, f), join(migDir, f));
    runMigrations(sqlite, migDir);
    sqlite.pragma("foreign_keys = OFF");
    seedParents();
    insertTx("tx1", "expense", 100);
    insertTx("tx2", "transfer", 200);
    // 旧实现给 0 利率贷款每期写一条 0 元「贷款利息」支出：0024 必须先清掉它，
    // 否则 CHECK (amount > 0) 会让迁移失败、应用起不来（0 元对账目没有任何影响）
    sqlite
      .prepare("INSERT INTO transactions (id,user_id,ledger_id,account_id,type,amount,currency,date,created_at,updated_at,source_type,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("zero-interest", "U1", "L1", "A1", "expense", 0, "CNY", "2026-01-01", "x", "x", "loan-interest", "贷款利息 X 第1期");
    sqlite.pragma("foreign_keys = ON");

    // 升级前：确无 CHECK（这就是被漏掉的防线）
    const before = (sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='transactions'").get() as { sql: string }).sql;
    assert.ok(!before.includes("CHECK"), "0023 阶段的 transactions 不应有 CHECK（历史缺陷现场）");

    copyFileSync(join(repo, "0024_transactions_check_restore.sql"), join(migDir, "0024_transactions_check_restore.sql"));
    runMigrations(sqlite, migDir);

    const after = (sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='transactions'").get() as { sql: string }).sql;
    assert.ok(after.includes("CHECK (type IN ('income', 'expense', 'transfer'))"), "应补回 type 枚举 CHECK");
    assert.ok(after.includes("CHECK (amount > 0)"), "应补回 amount > 0 CHECK");

    // 数据与索引必须完整保留
    const rows = sqlite.prepare("SELECT id, type, amount FROM transactions ORDER BY id").all() as { id: string }[];
    assert.deepEqual(rows.map((r) => r.id), ["tx1", "tx2"], "重建后数据必须保留，且 0 元贷款利息流水已被清理");
    assert.deepEqual(
      txIndexNames(),
      ["idx_tx_dedup", "idx_tx_ledger", "idx_tx_user_account", "idx_tx_user_date", "uniq_recurring_tx", "uniq_tx_client_request", "uniq_tx_external_source"],
      "7 个索引必须全部重建（含 0023 的部分唯一索引）",
    );
    assert.deepEqual(sqlite.pragma("foreign_key_check"), [], "重建后外键检查必须无误");
    assert.throws(() => insertTx("tx3", "expense", 0), /CHECK constraint failed: amount > 0/, "0 元流水必须被数据库拒绝");
    assert.throws(() => insertTx("tx4", "bogus", 100), /CHECK constraint failed/, "非法类型必须被数据库拒绝");
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // 非法历史行：迁移必须失败并整体回滚（不静默丢数据、不标记已应用）
  const dir2 = mkdtempSync(join(tmpdir(), "tally-mig-check-bad-"));
  const migDir2 = join(dir2, "migrations");
  mkdirSync(migDir2, { recursive: true });
  const { sqlite: sq2 } = createDb(join(dir2, "t.db"));
  try {
    for (const f of files.filter((f) => f < "0024")) copyFileSync(join(repo, f), join(migDir2, f));
    runMigrations(sq2, migDir2);
    sq2.pragma("foreign_keys = OFF");
    sq2.prepare("INSERT INTO users (id, phone, created_at, updated_at) VALUES (?,?,?,?)").run("U1", "+8613800000001", "x", "x");
    sq2.prepare("INSERT INTO ledgers (id, user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("L1", "U1", "L", "x", "x");
    sq2.prepare("INSERT INTO accounts (id, user_id, name, ledger_id, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("A1", "U1", "A", "L1", "x", "x");
    sq2.prepare("INSERT INTO transactions (id,user_id,ledger_id,account_id,type,amount,currency,date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("bad", "U1", "L1", "A1", "expense", 0, "CNY", "2026-01-01", "x", "x");
    sq2.pragma("foreign_keys = ON");

    copyFileSync(join(repo, "0024_transactions_check_restore.sql"), join(migDir2, "0024_transactions_check_restore.sql"));
    assert.throws(() => runMigrations(sq2, migDir2), /CHECK constraint failed/, "存在非法历史行时迁移必须失败");

    const applied = sq2.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    assert.equal(applied.n, 23, "失败迁移不应被记录");
    const kept = sq2.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };
    assert.equal(kept.n, 1, "回滚后原始数据必须完好");
  } finally {
    sq2.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});
