import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/prune-retention.mjs", import.meta.url));
const NOW = "2026-08-20T12:00:00.000Z";

const tmpDirs: string[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tally-retention-"));
  tmpDirs.push(d);
  return d;
}

function makeBackup(dir: string, dayOffset: number, hour: number, min: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - dayOffset);
  d.setUTCHours(hour, min, 0, 0);
  const stamp =
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}` +
    `-${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}00`;
  const name = `tally-${stamp}.db`;
  writeFileSync(join(dir, name), "dummy");
  return name;
}

function runPrune(dir: string): { kept: string[]; deleted: string[] } {
  const out = execFileSync("node", [SCRIPT, dir, "--now", NOW, "--dry-run"], { encoding: "utf8" });
  const kept: string[] = [];
  const deleted: string[] = [];
  let section: "kept" | "deleted" | null = null;
  for (const line of out.split("\n")) {
    if (line.trim() === "KEPT:") { section = "kept"; continue; }
    if (line.trim() === "DELETE:") { section = "deleted"; continue; }
    const m = line.match(/^\s{2}(.+)$/);
    if (m && section) {
      (section === "kept" ? kept : deleted).push(m[1]);
    }
  }
  return { kept: kept.sort(), deleted: deleted.sort() };
}

after(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

test("recent7: 最近 7 天每天一份, 同一天只留最新", () => {
  const dir = freshDir();
  makeBackup(dir, 0, 9, 0);
  makeBackup(dir, 1, 9, 0);
  makeBackup(dir, 2, 9, 0);
  makeBackup(dir, 3, 9, 0);
  makeBackup(dir, 4, 9, 0);
  makeBackup(dir, 5, 9, 0);
  makeBackup(dir, 6, 9, 0);
  const dup = makeBackup(dir, 0, 8, 0);
  const { kept, deleted } = runPrune(dir);
  assert.equal(kept.length, 7, "recent 7 days keep one per day");
  assert.ok(kept.includes("tally-20260820-090000.db"), "keep latest of today");
  assert.ok(!kept.includes(dup), "earlier same-day removed");
  assert.ok(deleted.includes(dup), "earlier same-day in delete list");
});

test("weekly: 8-30 天每周仅保留一份", () => {
  const dir = freshDir();
  // 第 8 天（08-12）与第 10 天（08-10）同属一周（周一 08-10 起），按周去重只留一份
  const d8 = makeBackup(dir, 8, 9, 0);
  const d10 = makeBackup(dir, 10, 9, 0);
  const out = runPrune(dir);
  assert.equal(out.kept.length, 1, "one per iso week");
  assert.ok(out.kept.includes(d8) || out.kept.includes(d10), "保留该周最新一份");
});

test("monthly: 31-180 天每月仅保留一份", () => {
  const dir = freshDir();
  const d35 = makeBackup(dir, 35, 9, 0); // 2026-07-16
  const d65 = makeBackup(dir, 65, 9, 0); // 2026-06-16
  const d55 = makeBackup(dir, 55, 9, 0); // 2026-06-26（同 6 月，更新）
  const { kept } = runPrune(dir);
  assert.ok(kept.includes(d35), "july one");
  assert.ok(kept.includes(d55), "june keep newest");
  assert.ok(!kept.includes(d65), "june older dropped");
  assert.equal(kept.length, 2, "two months each one");
});

test("oldfuture: 超过 180 天删除, 未来时间戳不误删", () => {
  const dir = freshDir();
  const old1 = makeBackup(dir, 181, 9, 0);
  const old2 = makeBackup(dir, 200, 9, 0);
  const future = "tally-20270101-120000.db";
  writeFileSync(join(dir, future), "dummy");
  const { kept, deleted } = runPrune(dir);
  assert.ok(!kept.includes(old1));
  assert.ok(!kept.includes(old2));
  assert.ok(deleted.includes(old1));
  assert.ok(kept.includes(future));
});

test("dryrun 不实际删除文件", () => {
  const dir = freshDir();
  const f = makeBackup(dir, 250, 9, 0);
  runPrune(dir);
  assert.ok(existsSync(join(dir, f)), "dry-run must not delete");
});

test("空目录不报错", () => {
  const dir = freshDir();
  const out = execFileSync("node", [SCRIPT, dir, "--now", NOW, "--dry-run"], { encoding: "utf8" });
  assert.match(out, /KEPT:/);
});
