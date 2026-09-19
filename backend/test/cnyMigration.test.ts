process.env.ALIYUN_SMS_ENABLED = "false";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildDedupKey, normalizeMerchant } from "../src/lib/dedup.js";

// 0027（多币种/汇率下线，全站 CNY）与 0028（负债残留列）的升级回归。
// 重点不是「迁移能跑完」，而是三件容易悄悄做错的事：
//   1) 非 CNY 金额必须被折算（不是 1:1 直接改列），且原币种/原金额留在备注里可追溯；
//   2) 人民币流水的 dedup_key 必须仍然与旧格式可比（载荷里的 "CNY" 是保留字面量）；
//   3) 折算/删列之后行数、外键、parent 关系都不受影响。

const repo = resolve("./migrations");
const files = readdirSync(repo).filter((f) => f.endsWith(".sql")).sort();
const now = "2026-01-01T00:00:00Z";

function seedLegacyDb(sqlite: ReturnType<typeof createDb>["sqlite"]) {
  sqlite
    .prepare("INSERT INTO users (id, phone, created_at, updated_at) VALUES (?,?,?,?)")
    .run("U1", "+8613800000001", now, now);
  sqlite
    .prepare("INSERT INTO ledgers (id, user_id, name, currency, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("L1", "U1", "默认账本", "CNY", 1, now, now);
  // 一个人民币账户 + 一个港币账户（初始余额 1000.00 HKD）
  sqlite
    .prepare("INSERT INTO accounts (id, user_id, ledger_id, name, type, currency, initial_balance, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("A1", "U1", "L1", "人民币户", "bank", "CNY", 0, now, now);
  sqlite
    .prepare("INSERT INTO accounts (id, user_id, ledger_id, name, type, currency, initial_balance, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("A2", "U1", "L1", "港币户", "bank", "HKD", 100000, now, now);
  const tx = sqlite.prepare(
    "INSERT INTO transactions (id,user_id,ledger_id,account_id,type,amount,currency,note,date,external_id,source_type,dedup_key,payment_group_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  // 人民币流水（不应被改动，dedup_key 必须原样保留）
  tx.run("T_CNY", "U1", "L1", "A1", "expense", 12345, "CNY", "午饭", "2026-01-05", null, "manual", buildDedupKey("2026-01-05", 12345, "午饭"), null, now, now);
  // 港币一收一支（各 5000.00 HKD，按内置兜底 0.92 → 各 4600.00 CNY）
  tx.run("T_HKD_IN", "U1", "L1", "A2", "income", 500000, "HKD", "结售汇即时售汇 彭冲", "2026-02-10", "bank:2026-02-10:HKD:500000:结售汇即时售汇 彭冲", "bank", buildDedupKey("2026-02-10", 500000, "结售汇即时售汇 彭冲"), "PG1", now, now);
  tx.run("T_HKD_OUT", "U1", "L1", "A2", "expense", 500000, "HKD", "柜台取现", "2026-02-10", "bank:2026-02-10:HKD:500000:柜台取现", "bank", buildDedupKey("2026-02-10", 500000, "柜台取现"), "PG1", now, now);
  // 导入暂存明细：指向上面那条人民币流水（transactions 是它的父表，验证删列不破坏外键）
  sqlite
    .prepare("INSERT INTO import_jobs (id, ledger_id, user_id, source, status, total_count, imported_count, skipped_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("J1", "L1", "U1", "bank", "committed", 1, 1, 0, now, now);
  const item = sqlite.prepare(
    "INSERT INTO import_items (id,job_id,account_id,external_id,occurred_at,type,amount,currency,merchant,source,duplicate_status,duplicate_score,matched_transaction_id,decision,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  item.run("I1", "J1", "A1", "bank:2026-01-05:CNY:expense:12345:午饭", "2026-01-05", "expense", 12345, "CNY", "午饭", "bank", "new", 0, "T_CNY", "accept", now);
  item.run("I2", "J1", "A2", "bank:2026-02-10:HKD:500000:柜台取现", "2026-02-10", "expense", 500000, "HKD", "柜台取现", "bank", "new", 0, "T_HKD_OUT", "accept", now);
  // 汇率表为空 → 必须走内置兜底汇率（生产实测同样是 0 行）
}

test("0027/0028：非 CNY 金额按汇率折算并入备注，币种列/汇率表/负债残留列下线", () => {
  const dir = mkdtempSync(join(tmpdir(), "tally-mig-cny-"));
  const migDir = join(dir, "migrations");
  mkdirSync(migDir, { recursive: true });
  const { sqlite } = createDb(join(dir, "t.db"));
  try {
    // 老库阶段：应用到 0026（仍有 currency 列与 exchange_rates 表）
    for (const f of files.filter((f) => f < "0027")) copyFileSync(join(repo, f), join(migDir, f));
    runMigrations(sqlite, migDir);
    seedLegacyDb(sqlite);
    const before = {
      transactions: (sqlite.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n,
      accounts: (sqlite.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n,
      items: (sqlite.prepare("SELECT COUNT(*) AS n FROM import_items").get() as { n: number }).n,
    };

    for (const f of files.filter((f) => f >= "0027")) copyFileSync(join(repo, f), join(migDir, f));
    runMigrations(sqlite, migDir);

    // 1) 表与列下线
    const table = (t: string) => sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    for (const t of ["exchange_rates", "budgets"]) assert.equal(table(t), undefined, `${t} 表应已删除`);
    const cols = (t: string) => (sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    for (const t of ["ledgers", "accounts", "transactions", "import_items"]) {
      assert.ok(!cols(t).includes("currency"), `${t} 不应再有 currency 列`);
    }
    assert.ok(!cols("transactions").includes("payment_group_id"), "transactions 不应再有 payment_group_id 列");

    // 2) 折算：HKD 5000.00 → CNY 4600.00，原币种/原金额/汇率写进备注
    const hkdIn = sqlite.prepare("SELECT amount, note, dedup_key FROM transactions WHERE id='T_HKD_IN'").get() as { amount: number; note: string; dedup_key: string | null };
    assert.equal(hkdIn.amount, 460000, "5000.00 HKD 应折算为 4600.00 CNY（内置兜底 0.92）");
    assert.match(hkdIn.note, /原 HKD 5000\.00/);
    assert.match(hkdIn.note, /1 HKD = 0\.92 CNY/);
    assert.match(hkdIn.note, /结售汇即时售汇 彭冲/, "原备注必须保留");
    assert.equal(hkdIn.dedup_key, null, "折算后旧指纹必然失真，应置空（硬去重靠 external_id）");
    const hkdOut = sqlite.prepare("SELECT amount FROM transactions WHERE id='T_HKD_OUT'").get() as { amount: number };
    assert.equal(hkdOut.amount, 460000);
    // 账户初始余额同样折算：1000.00 HKD → 920.00 CNY
    const acct = sqlite.prepare("SELECT initial_balance FROM accounts WHERE id='A2'").get() as { initial_balance: number };
    assert.equal(acct.initial_balance, 92000, "1000.00 HKD 初始余额应折算为 920.00 CNY");

    // 3) 人民币数据零改动：金额与指纹都保持原样
    const cny = sqlite.prepare("SELECT amount, note, dedup_key, external_id FROM transactions WHERE id='T_CNY'").get() as { amount: number; note: string; dedup_key: string; external_id: string | null };
    assert.equal(cny.amount, 12345);
    assert.equal(cny.note, "午饭");
    assert.equal(cny.dedup_key, buildDedupKey("2026-01-05", 12345, "午饭"), "人民币流水的 dedup_key 必须与新实现完全一致（历史指纹仍可比）");

    // 4) 行数不变、外键与 parent 关系完好
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n, before.transactions);
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n, before.accounts);
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM import_items").get() as { n: number }).n, before.items);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), [], "迁移后外键检查应无误");
    const linked = sqlite.prepare("SELECT matched_transaction_id FROM import_items WHERE id='I2'").get() as { matched_transaction_id: string | null };
    assert.equal(linked.matched_transaction_id, "T_HKD_OUT", "暂存明细指向流水的关联必须保留（transactions 是父表）");
    // external_id 保持来源原样（不重写），硬去重语义不变
    assert.equal(cny.external_id, null);
    const keptExternal = sqlite.prepare("SELECT external_id FROM transactions WHERE id='T_HKD_OUT'").get() as { external_id: string };
    assert.equal(keptExternal.external_id, "bank:2026-02-10:HKD:500000:柜台取现");

    // 5) 重复执行幂等：再跑一次不会因为「表/列已不存在」而失败
    runMigrations(sqlite, migDir);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dedup_key 指纹格式锁定：载荷中的 CNY 是保留字面量（旧指纹仍可比）", () => {
  const note = "午饭";
  const expected = createHash("sha1").update(`2026-01-05|12345|CNY|${normalizeMerchant(note)}`, "utf8").digest("hex");
  assert.equal(buildDedupKey("2026-01-05", 12345, note), expected);
});
