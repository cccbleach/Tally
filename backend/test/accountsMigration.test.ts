process.env.ALIYUN_SMS_ENABLED = "false";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";

// 0029（账户域下线）的升级回归：三张子表重建 + accounts 表删除。
// 重点钉死四件容易悄悄做错的事：
//   1) 数据一条不少（三张表行数不变），外键检查与完整性无损；
//   2) CHECK 收紧为 ('income','expense')，历史转账行必须让迁移**显式失败**而不是被静默改写；
//   3) 索引保真：丢 idx_tx_user_account，其余（含 ledger 作用域的离线幂等索引）逐字保留；
//   4) 删掉 account_id 后 import_items.matched_transaction_id 指向流水的关联仍保留。

const repo = resolve("./migrations");
const files = readdirSync(repo).filter((f) => f.endsWith(".sql")).sort();
const now = "2026-01-01T00:00:00Z";

function seedLegacyDb(sqlite: ReturnType<typeof createDb>["sqlite"], opts: { withTransfer?: boolean } = {}) {
  sqlite.prepare("INSERT INTO users (id, phone, created_at, updated_at) VALUES (?,?,?,?)").run("U1", "+8613800000001", now, now);
  sqlite.prepare("INSERT INTO ledgers (id, user_id, name, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("L1", "U1", "默认账本", 1, now, now);
  sqlite.prepare("INSERT INTO accounts (id, user_id, ledger_id, name, type, initial_balance, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("A1", "U1", "L1", "唯一账户", "other", 0, now, now);
  const tx = sqlite.prepare(
    "INSERT INTO transactions (id,user_id,ledger_id,account_id,category_id,type,amount,note,date,external_id,source_type,dedup_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  tx.run("T_IN", "U1", "L1", "A1", null, "income", 50000, "收入", "2026-01-05", null, "manual", null, now, now);
  tx.run("T_OUT", "U1", "L1", "A1", null, "expense", 12345, "支出", "2026-01-06", null, "manual", null, now, now);
  if (opts.withTransfer) {
    // 单账户下的转账本不该存在；造一条用来验证守门（CHECK 收紧）会让迁移显式失败
    tx.run("T_TR", "U1", "L1", "A1", null, "transfer", 100, "转账", "2026-01-07", null, "manual", null, now, now);
  }
  sqlite.prepare("INSERT INTO import_jobs (id, ledger_id, user_id, source, status, total_count, imported_count, skipped_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("J1", "L1", "U1", "bank", "committed", 1, 1, 0, now, now);
  sqlite.prepare(
    "INSERT INTO import_items (id,job_id,account_id,external_id,occurred_at,type,amount,merchant,source,duplicate_status,duplicate_score,matched_transaction_id,decision,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("I1", "J1", "A1", "bank:2026-01-06:CNY:expense:12345:支出", "2026-01-06", "expense", 12345, "支出", "bank", "new", 0, "T_OUT", "accept", now);
}

function copyMigrations(migDir: string, range: (f: string) => boolean) {
  for (const f of files.filter(range)) copyFileSync(join(repo, f), join(migDir, f));
}

test("0029：accounts 表与账户列删除，数据/索引/关联保真，CHECK 收紧", () => {
  const dir = mkdtempSync(join(tmpdir(), "tally-mig-acc-"));
  const migDir = join(dir, "migrations");
  mkdirSync(migDir, { recursive: true });
  const { sqlite } = createDb(join(dir, "t.db"));
  try {
    copyMigrations(migDir, (f) => f < "0029");
    runMigrations(sqlite, migDir);
    seedLegacyDb(sqlite);
    const before = {
      tx: (sqlite.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n,
      items: (sqlite.prepare("SELECT COUNT(*) AS n FROM import_items").get() as { n: number }).n,
    };

    copyMigrations(migDir, (f) => f >= "0029");
    runMigrations(sqlite, migDir);

    // 1) accounts 表消失；三张子表不再有账户列
    const accounts = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get();
    assert.equal(accounts, undefined, "accounts 表应已删除");
    for (const [t, cols] of [
      ["transactions", ["account_id", "transfer_to_account_id"]],
      ["recurring", ["account_id"]],
      ["import_items", ["account_id"]],
    ] as const) {
      const live = (sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      for (const col of cols) assert.ok(!live.includes(col), `${t} 不应再有 ${col} 列`);
    }

    // 2) CHECK 收紧 + 数据一条不少 + 完整性无损
    const ddl = (sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='transactions'").get() as { sql: string }).sql;
    assert.ok(ddl.includes("CHECK (type IN ('income', 'expense'))"), "type CHECK 应只剩收入/支出");
    assert.ok(!ddl.includes("'transfer'"), "不应再允许 transfer 类型");
    assert.ok(ddl.includes("CHECK (amount > 0)"), "amount > 0 应保留");
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n, before.tx);
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM import_items").get() as { n: number }).n, before.items);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), [], "外键检查应无误");
    assert.deepEqual(sqlite.pragma("integrity_check"), [{ integrity_check: "ok" }]);

    // 3) 索引保真：丢账户维度索引，其余逐字保留
    const idx = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='transactions' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(idx, ["idx_tx_dedup", "idx_tx_ledger", "idx_tx_user_date", "uniq_recurring_tx", "uniq_tx_client_request", "uniq_tx_external_source"]);

    // 4) 关联与写入路径仍可用：matched_transaction_id 指向流水；新的写入不再接受 transfer
    const linked = sqlite.prepare("SELECT matched_transaction_id FROM import_items WHERE id='I1'").get() as { matched_transaction_id: string | null };
    assert.equal(linked.matched_transaction_id, "T_OUT", "暂存明细指向流水的关联必须保留");
    assert.throws(
      () => sqlite.prepare("INSERT INTO transactions (id,user_id,ledger_id,type,amount,date,created_at,updated_at) VALUES ('T_BAD','U1','L1','transfer',100,'2026-01-08','x','x')").run(),
      /CHECK constraint failed/,
      "数据库层必须直接拒绝 transfer",
    );
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("0029 反例：存在历史转账行时迁移必须显式失败并整体回滚", () => {
  const dir = mkdtempSync(join(tmpdir(), "tally-mig-acc-bad-"));
  const migDir = join(dir, "migrations");
  mkdirSync(migDir, { recursive: true });
  const { sqlite } = createDb(join(dir, "t.db"));
  try {
    copyMigrations(migDir, (f) => f < "0029");
    runMigrations(sqlite, migDir);
    seedLegacyDb(sqlite, { withTransfer: true });

    copyMigrations(migDir, (f) => f >= "0029");
    assert.throws(() => runMigrations(sqlite, migDir), /CHECK constraint failed/, "转账历史行必须阻断迁移");

    const applied = sqlite.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    assert.equal(applied.n, 28, "失败的迁移不应被记录（0029 未应用）");
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get(), "回滚后 accounts 表应仍在");
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n, 3, "回滚后原始数据必须完好");
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
