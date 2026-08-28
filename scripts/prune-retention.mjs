#!/usr/bin/env node
// 备份保留策略脚本（与测试共用同一实现）
// 用法: node scripts/prune-retention.mjs <backup_dir> [--now <ISO>] [--dry-run]
// 策略:
//   最近 7 天   : 每天一份  (0 <= ageDays < 7)
//   8-30 天     : 每周一份  (7 <= ageDays < 30)
//   31-180 天   : 每月一份  (30 <= ageDays < 180)
//   超过 180 天 : 删除
import { readdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";

const DAY = 24 * 60 * 60 * 1000;
const FILENAME_RE = /^(.*?)(\d{8})-(\d{6})\.db$/;

function parseArgs(args) {
  let dir = args[0];
  let now = new Date();
  let dryRun = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--now") now = new Date(args[++i]);
    else if (args[i] === "--dry-run") dryRun = true;
  }
  if (!dir) {
    console.error("用法: node scripts/prune-retention.mjs <backup_dir> [--now <ISO>] [--dry-run]");
    process.exit(2);
  }
  return { dir, now, dryRun };
}

export function computeRetention(files, now) {
  const DAYS = { daily: 7, weekly: 30, monthly: 180 };
  const buckets = new Map();
  const toDelete = [];

  for (const f of files) {
    const ageDays = Math.floor((now.getTime() - f.createdAt.getTime()) / DAY);
    let key;
    if (ageDays < 0) {
      key = "future|" + f.createdAt.toISOString();
    } else if (ageDays < DAYS.daily) {
      key = "d|" + isoDay(f.createdAt);
    } else if (ageDays < DAYS.weekly) {
      key = "w|" + isoWeek(f.createdAt);
    } else if (ageDays < DAYS.monthly) {
      key = "m|" + monthKey(f.createdAt);
    } else {
      toDelete.push(f.path);
      continue;
    }
    const cur = buckets.get(key);
    if (!cur || f.createdAt.getTime() > cur.createdAt.getTime()) {
      if (cur) toDelete.push(cur.path);
      buckets.set(key, f);
    } else {
      toDelete.push(f.path);
    }
  }
  return { toDelete };
}

function isoDay(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

function monthKey(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

function isoWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY));
  return date.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

function parseBackupFiles(dir) {
  return readdirSync(dir)
    .filter((name) => FILENAME_RE.test(name))
    .map((name) => {
      const m = FILENAME_RE.exec(name);
      const date = m[2];
      const time = m[3];
      const createdAt = new Date(
        date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8) +
        "T" + time.slice(0, 2) + ":" + time.slice(2, 4) + ":" + time.slice(4, 6) + "Z"
      );
      return { path: join(dir, name), name, createdAt };
    });
}

export function pruneBackups(dir, now, dryRun) {
  const files = parseBackupFiles(dir);
  const { toDelete } = computeRetention(files, now);
  const kept = files.filter((f) => !toDelete.includes(f.path)).map((f) => f.name).sort();
  if (!dryRun) {
    for (const p of toDelete) {
      try { rmSync(p, { force: true }); } catch {}
    }
  }
  return { kept, toDelete: toDelete.map((p) => basename(p)).sort(), dryRun };
}

function main() {
  const { dir, now, dryRun } = parseArgs(process.argv.slice(2));
  const result = pruneBackups(dir, now, dryRun);
  if (dryRun) {
    console.log("KEPT:");
    for (const k of result.kept) console.log("  " + k);
    console.log("DELETE:");
    for (const d of result.toDelete) console.log("  " + d);
  } else {
    console.log("保留策略已应用：保留 " + result.kept.length + " 份，删除 " + result.toDelete.length + " 份。");
  }
}

if (process.argv[1] && basename(process.argv[1]) === "prune-retention.mjs") {
  main();
}
