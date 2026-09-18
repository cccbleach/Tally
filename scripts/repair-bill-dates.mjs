#!/usr/bin/env node
// 数据修复：把 transactions.date 里的非 YYYY-MM-DD 坏值按「星期 + 月日」还原成真实日期。
//
// 背景（线上真实故障）：微信 xlsx 的「交易时间」是 Excel 日期单元格，被 xlsxWorker 的
// String(cell) 转成 "Tue Aug 18 2026 12:30:00 GMT+0800 (…)"，解析层再 slice(0,10) 落库成
// "Tue Aug 18"。这类值在字符串比较下排在所有 "2026-…" 之后，于是被排除在**每一个**按月
// 区间之外 —— 流水在 App 里完全看不见。解析器已修（见 billParser/xlsxWorker），本脚本修历史数据。
//
// 用法（必须在 release 目录或 backend/ 目录下运行，以便解析到 better-sqlite3）：
//   node scripts/repair-bill-dates.mjs /var/lib/tally/tally.db              # 预演，不写库
//   node scripts/repair-bill-dates.mjs /var/lib/tally/tally.db --apply      # 写入（务必先备份）
//   node scripts/repair-bill-dates.mjs <db> --apply --json /tmp/map.json    # 同时存档新旧映射
//
// 判定依据（两条独立校验，任一不满足就跳过该行并报告）：
//   1) 文本形如 "<Weekday> <Mon> <D>"，在 [2000, 今年] 窗口内找星期吻合的年份，必须唯一；
//   2) 若 external_id 内嵌 YYYYMMDD（微信交易单号确实含日期），必须与推得的日期一致。
//
// 另外：transactions.dedup_key = sha1(日期|金额|币种|规范化商家)，**含日期**，
// 所以改日期必须同步重算 dedup_key，否则跨来源（微信 vs 银行）模糊去重会失配。
// 重算用的是部署产物里的 dist/lib/dedup.js（与服务端同一份实现，避免算法漂移）；
// 找不到产物时跳过重算并告警（此时只有硬去重 external_id 生效，不影响账目）。
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const p2 = (n) => String(n).padStart(2, "0");

/** "Tue Aug 18" → { weekday: 2, month: 8, day: 18 }；非该形状返回 null */
export function parseBrokenDate(text) {
  const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+([A-Z][a-z]{2})\s+(\d{1,2})$/.exec(String(text).trim());
  if (!m) return null;
  const weekday = WEEKDAYS[m[1]];
  const month = MONTHS[m[2]];
  if (weekday === undefined || !month) return null;
  return { weekday, month, day: Number(m[3]) };
}

/**
 * 推断年份。窗口必须收窄，否则「星期 + 月日」在多年份上会重复
 * （实测 "Tue Aug 18" 在 2009/2015/2020/2026 都是周二）。
 * 锚点用导入时间 created_at：账单覆盖的日期不会晚于导入本身，跨年导入回看一年足够。
 * 唯一才返回 ISO；否则返回原因并由调用方跳过 —— 绝不猜。
 */
export function inferDate(parsed, createdYear, createdDate) {
  const hits = [];
  for (let y = createdYear - 1; y <= createdYear; y++) {
    const d = new Date(Date.UTC(y, parsed.month - 1, parsed.day));
    if (d.getUTCDate() !== parsed.day || d.getUTCMonth() !== parsed.month - 1) continue; // 该年这个月没有这天
    if (d.getUTCDay() !== parsed.weekday) continue;
    const iso = `${y}-${p2(parsed.month)}-${p2(parsed.day)}`;
    if (createdDate && iso > createdDate) continue; // 不可能在导入之后发生
    hits.push(iso);
  }
  if (hits.length === 0) return { error: `导入年份窗口 [${createdYear - 1}, ${createdYear}] 内没有星期吻合的日期` };
  if (hits.length > 1) return { error: `候选不唯一：${hits.join("/")}` };
  return { iso: hits[0] };
}

/** external_id 里内嵌的 YYYYMMDD（微信交易单号含日期），用于交叉验证 */
export function embeddedDate(externalId) {
  const id = String(externalId ?? "");
  const found = new Set();
  for (const m of id.matchAll(/(20\d{2})(\d{2})(\d{2})/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCDate() === d && dt.getUTCMonth() === mo - 1) found.add(`${y}-${p2(mo)}-${p2(d)}`);
  }
  return [...found];
}

/**
 * 判定单号内嵌日期与文本星期是否自洽。
 * 文本来自 `String(date)` 按服务器本地时区（+08）渲染：16:00 之后的交易会跨过午夜，
 * 文本日期比真实日期**晚一天**（线上实测 103/103 都是 +1）。
 * 因此允许「同一天」与「文本晚一天」两种；其余视为矛盾。
 */
export function pickAuthoritativeDate(embeddedDates, textWeekday, { minYear = 0, maxYear = 9999 } = {}) {
  const wdOf = (iso) =>
    new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))).getUTCDay();
  const consistent = embeddedDates.filter((iso) => {
    // 年份窗口必须一并收窄：商户单号格式不同，随机数字里会凑出 "2000-03-21" 这类假日期
    // （线上 50 条就是这样被误判成「多个候选」的）
    const year = Number(iso.slice(0, 4));
    if (year < minYear || year > maxYear) return false;
    const wd = wdOf(iso);
    return wd === textWeekday || wd === (textWeekday + 6) % 7;
  });
  if (consistent.length === 1) return { iso: consistent[0] };
  if (consistent.length === 0) return { error: "与文本星期不符，数据自相矛盾" };
  return { error: `单号内有多个候选日期：${consistent.join("/")}` };
}

export async function runRepair(dbPath, { apply = false, jsonPath = null, Database } = {}) {
if (!Database) {
  const require = createRequire(`${process.cwd()}/package.json`);
  Database = require("better-sqlite3");
}
const db = new Database(dbPath, { readonly: !apply });
const rows = db.prepare("SELECT id, date, external_id, created_at FROM transactions WHERE date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'").all();

const fixes = [];
const skipped = [];
for (const r of rows) {
  const parsed = parseBrokenDate(r.date);
  if (!parsed) {
    skipped.push({ id: r.id, date: r.date, reason: "文本形状无法识别" });
    continue;
  }
  const createdYear = Number(String(r.created_at ?? "").slice(0, 4));
  if (!Number.isInteger(createdYear) || createdYear < 2000) {
    skipped.push({ id: r.id, date: r.date, reason: "缺少可用的导入时间（created_at）" });
    continue;
  }
  const createdDate = String(r.created_at ?? "").slice(0, 10);
  const embedded = embeddedDate(r.external_id);

  // 单号内嵌日期（微信交易单号含 YYYYMMDD）是**权威**日期，直接采用。
  // 文本日期是 `String(date)` 按服务器本地时区(+08)渲染的结果：16:00 之后的交易会跨过午夜，
  // 于是文本日期比真实日期**系统性晚一天**（线上实测 103/103 都是 +1）。
  // 因此一致性校验允许「同一天」或「文本晚一天」两种，其余一律视为矛盾并跳过。
  if (embedded.length) {
    const picked = pickAuthoritativeDate(embedded, parsed.weekday, { minYear: createdYear - 1, maxYear: createdYear });
    if (picked.iso) {
      fixes.push({ id: r.id, from: r.date, to: picked.iso, crossChecked: true });
      continue;
    }
    skipped.push({ id: r.id, date: r.date, reason: `单号内嵌日期(${embedded.join("/")})${picked.error}` });
    continue;
  }

  // 没有单号内嵌日期时，文本日期存在 ±1 天的时区歧义（无法从数据本身判别），
  // 因此只做年份窗口推断；窗口内不唯一就跳过并报告，绝不猜。
  const inferred = inferDate(parsed, createdYear, createdDate);
  if (inferred.error) {
    skipped.push({ id: r.id, date: r.date, reason: inferred.error });
    continue;
  }
  fixes.push({ id: r.id, from: r.date, to: inferred.iso, crossChecked: false, note: "无单号交叉验证，文本日期可能有 ±1 天时区偏差" });
}

const byMonth = {};
for (const f of fixes) byMonth[f.to.slice(0, 7)] = (byMonth[f.to.slice(0, 7)] ?? 0) + 1;
console.log(`坏日期行合计: ${rows.length}`);
console.log(`可精确修复  : ${fixes.length}（其中 ${fixes.filter((f) => f.crossChecked).length} 条由单号内嵌日期直接确定）`);
if (fixes.some((f) => !f.crossChecked)) console.log("  仅靠星期推断（无单号，可能有 ±1 天时区偏差）:", fixes.filter((f) => !f.crossChecked).length);
console.log(`跳过（需人工）: ${skipped.length}`);
if (skipped.length) console.log("  跳过明细:", JSON.stringify(skipped.slice(0, 10)));
console.log("修复后月份分布:", JSON.stringify(byMonth));
console.log("样例:", JSON.stringify(fixes.slice(0, 5)));

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ dbPath, generatedAt: new Date().toISOString(), apply, fixes, skipped }, null, 2));
  console.log(`映射已存档: ${jsonPath}`);
}

if (!apply) {
  console.log("\n（预演模式：未写库。加 --apply 执行写入；写入前请先备份数据库。）");
  db.close();
  return { total: rows.length, fixed: 0, skipped: skipped.length };
}

// dedup_key 含日期 → 同步重算（仅在原本非空时重算，保持 NULL 语义不变）
let buildDedupKey = null;
try {
  const distDedup = `${process.cwd()}/dist/lib/dedup.js`;
  ({ buildDedupKey } = await import(pathToFileURL(distDedup).href));
} catch {
  console.warn("⚠️ 未找到 dist/lib/dedup.js：跳过 dedup_key 重算（请从 release 目录运行本脚本）");
}

const details = new Map(
  db.prepare("SELECT id, amount, currency, note, dedup_key FROM transactions WHERE id IN (" +
    fixes.map(() => "?").join(",") + ")").all(fixes.map((f) => f.id))
    .map((r) => [r.id, r]),
);
const update = db.prepare("UPDATE transactions SET date = ? WHERE id = ? AND date = ?");
const updateDedup = db.prepare("UPDATE transactions SET dedup_key = ? WHERE id = ?");
const applyAll = db.transaction((list) => {
  let n = 0;
  let dedup = 0;
  for (const f of list) {
    n += update.run(f.to, f.id, f.from).changes;
    const row = details.get(f.id);
    if (buildDedupKey && row && row.dedup_key) {
      const next = buildDedupKey(f.to, row.amount, row.currency, row.note);
      if (next !== row.dedup_key) dedup += updateDedup.run(next, f.id).changes;
    }
  }
  console.log(`dedup_key 重算行数: ${dedup}`);
  return n;
});
const changed = applyAll(fixes);
const remaining = db.prepare("SELECT COUNT(*) c FROM transactions WHERE date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'").get().c;
console.log(`\n已写入 ${changed} 行；剩余非 ISO 日期行: ${remaining}`);
if (remaining !== skipped.length) {
  console.error("⚠️ 剩余行数与跳过数不一致，请人工复核");
  process.exitCode = 1;
}
db.close();
return { total: rows.length, fixed: changed, skipped };
}

// 直接执行时才是 CLI；被测试 import 时只取纯函数
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , dbPath, ...flags] = process.argv;
  const apply = flags.includes("--apply");
  const i = flags.indexOf("--json");
  const jsonPath = i >= 0 ? flags[i + 1] : null;
  if (!dbPath) {
    console.error("用法: node scripts/repair-bill-dates.mjs <db-path> [--apply] [--json <map-output>]");
    process.exit(2);
  }
  await runRepair(dbPath, { apply, jsonPath });
}
