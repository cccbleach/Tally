#!/usr/bin/env node
// 历史流水的关键词重分类：把「全部挂在第一个分类」的存量数据按备注重新归类。
// 与 scripts/repair-bill-dates.mjs 同一套安全模式：
//   - 默认预演（只打印，不写库）；--apply 才写；写库前自动备份；自动落一份新旧对照 JSON。
//   - 分类规则用部署产物里的 dist/lib/categorize.js（与服务端导入路径同一份实现，避免漂移）。
//   - 只改 category_id；不碰金额/日期/去重键（分类不参与 dedup_key 与 external_id）。
//
// 用法（在 release 目录下）：
//   node scripts/recategorize.mjs                 # 预演
//   node scripts/recategorize.mjs --apply         # 写库（先自动备份）
//   node scripts/recategorize.mjs --apply --json /tmp/map.json   # 自定对照文件路径
//
// 判定细节：只处理 income/expense 流水；每个账本用自己的分类表做关键词匹配；
// 支出未命中 → category_id 置 NULL（UI 显示「未分类」），不再硬塞第一个分类；
// 收入未命中 → 回退「其他收入」；这些语义全部来自 dist/lib/categorize.js。

import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const jsonIdx = args.indexOf("--json");
const JSON_OUT = jsonIdx >= 0 ? args[jsonIdx + 1] : null;

const dbPath = process.env.DATABASE_URL || "./data/tally.db";
const { default: Database } = await import("better-sqlite3");
const db = new Database(dbPath);
try {
  db.pragma("journal_mode = WAL");
} catch {}

let suggestCategoryId = null;
try {
  const distCategorize = `${process.cwd()}/dist/lib/categorize.js`;
  ({ suggestCategoryId } = await import(pathToFileURL(distCategorize).href));
} catch {
  console.error("❌ 未找到 dist/lib/categorize.js：请从 release 目录（构建产物）运行本脚本。");
  process.exit(1);
}

const nameOf = (() => {
  const stmt = db.prepare("SELECT name FROM categories WHERE id = ?");
  return (id) => (id ? (stmt.get(id)?.name ?? "(已删分类)") : "(未分类)");
})();

const ledgers = db.prepare("SELECT id, name FROM ledgers WHERE deleted_at IS NULL").all();
const catsStmt = db.prepare("SELECT id, name, type FROM categories WHERE ledger_id = ?");
const txStmt = db.prepare(
  "SELECT id, type, note, category_id FROM transactions WHERE ledger_id = ? AND type IN ('income','expense')",
);
const updStmt = db.prepare("UPDATE transactions SET category_id = ? WHERE id = ? AND category_id IS ?");
const totalStmt = db.prepare("SELECT COUNT(*) c FROM transactions");

console.log(`数据库：${dbPath}`);
console.log(`模式：${APPLY ? "⚠️  APPLY（将写库，先自动备份）" : "预演（不写库）"}`);
console.log(`账本数：${ledgers.length}`);

// 逐账本分类（分类是账本维度的，不能跨账本共用 id）
const changes = [];
for (const ledger of ledgers) {
  const cats = catsStmt.all(ledger.id);
  const rows = txStmt.all(ledger.id);
  for (const row of rows) {
    const suggested = suggestCategoryId(row.note, cats, row.type);
    if ((suggested ?? null) === (row.category_id ?? null)) continue;
    changes.push({
      id: row.id,
      ledger: ledger.name,
      type: row.type,
      note: (row.note ?? "").slice(0, 60),
      from: nameOf(row.category_id),
      to: nameOf(suggested),
      from_id: row.category_id ?? null,
      to_id: suggested,
    });
  }
}

const before = db
  .prepare(
    "SELECT category_id, SUM(amount) s, COUNT(*) n FROM transactions WHERE type = 'expense' GROUP BY category_id ORDER BY s DESC",
  )
  .all();
console.log("\n=== 重分类前支出分布（分类 → 笔数 / 金额元） ===");
for (const r of before) {
  console.log(`  ${nameOf(r.category_id).padEnd(8)} ${String(r.n).padStart(5)} 笔  ${(r.s / 100).toFixed(2)} 元`);
}

const byTo = new Map();
for (const c of changes) byTo.set(c.to, (byTo.get(c.to) ?? 0) + 1);
console.log(`\n=== 将要修改 ${changes.length} 条 ===`);
for (const [to, n] of [...byTo.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  → ${to}: ${n} 条`);
}
console.log("\n=== 样例（每个目标分类前 5 条） ===");
const seen = new Map();
for (const c of changes) {
  const n = seen.get(c.to) ?? 0;
  if (n >= 5) continue;
  seen.set(c.to, n + 1);
  console.log(`  [${c.from} → ${c.to}] ${c.note}`);
}

const writeMap = (path) => {
  writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), changes }, null, 2));
  console.log(`新旧对照已写入 ${path}`);
};
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
if (JSON_OUT) writeMap(JSON_OUT);

if (!APPLY) {
  console.log("\n（预演结束：未写库。确认无误后加 --apply 执行）");
  process.exit(0);
}
if (changes.length === 0) {
  console.log("\n没有需要修改的行。");
  process.exit(0);
}

console.log("\n=== APPLY：写库前自动备份 ===");
const backupPath = `/var/lib/tally/backups/tally-pre-recategorize-${stamp}.db`;
try {
  execFileSync("sudo", ["-u", "tally", "sqlite3", dbPath, `.backup '${backupPath}'`], { stdio: "inherit" });
  console.log(`备份完成：${backupPath}`);
} catch (e) {
  console.error(`❌ 备份失败（${e.message}）：中止，不写库。`);
  process.exit(1);
}

const applyAll = db.transaction((list) => {
  let n = 0;
  for (const c of list) n += updStmt.run(c.to_id, c.id, c.from_id).changes;
  return n;
});
const changed = applyAll(changes);
console.log(`\n已更新 ${changed} 条（流水总数仍为 ${totalStmt.get().c}）`);
if (!JSON_OUT) writeMap(`/var/lib/tally/backups/recategorize-map-${stamp}.json`);

const after = db
  .prepare(
    "SELECT category_id, COUNT(*) n, SUM(amount) s FROM transactions WHERE type = 'expense' GROUP BY category_id ORDER BY n DESC",
  )
  .all();
console.log("\n=== 重分类后支出分布 ===");
for (const r of after) {
  console.log(`  ${(nameOf(r.category_id)).padEnd(8)} ${String(r.n).padStart(5)} 笔  ${(r.s / 100).toFixed(2)} 元`);
}
