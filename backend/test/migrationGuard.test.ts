process.env.ALIYUN_SMS_ENABLED = "false";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";

// 回归：0021/0022 升级迁移必须有显式守门——不静默提权、不静默删邀请、不放过非法手机号。
// 每依赖包含：viewer、旧邀请、非法 +86、空格手机号、NFKC/大小写冲突昵称的 0020 老库升级路径。

const repo = resolve("./migrations");
const files = (() => readdirSync(repo).filter((f) => f.endsWith(".sql")).sort())();

function makeUpgradeDir() {
  const dir = mkdtempSync(join(tmpdir(), "tally-mig-guard-"));
  const migDir = join(dir, "migrations");
  mkdirSync(migDir, { recursive: true });
  for (const f of files.filter((f) => f < "0021")) copyFileSync(join(repo, f), join(migDir, f));
  return { dir, migDir, dbName: join(dir, "t.db") };
}

test("干净老库（无家庭数据）→ 0022 升级成功，全部 22 个迁移应用", () => {
  const { migDir, dbName } = makeUpgradeDir();
  const { sqlite } = createDb(dbName);
  try {
    runMigrations(sqlite, migDir);
    // 老库只有 18+2=20 个
    const before = sqlite.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    assert.equal(before.n, 20, "老库应为 20 个迁移");
    for (const f of files.filter((f) => f >= "0021")) copyFileSync(join(repo, f), join(migDir, f));
    runMigrations(sqlite, migDir);
    const applied = sqlite.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    assert.equal(applied.n, 22, "升级后应为 22 个迁移");
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), [], "外键检查应无误");
  } finally {
    sqlite.close();
    rmSync(migDir, { recursive: true, force: true });
  }
});

// 升级一个带旧数据的老库，返回 { ok, err, sqlite? }；ok=false 时 sqlite 已关闭。
async function upgrade(seed: (s: Database.Database) => void) {
  const { migDir, dbName } = makeUpgradeDir();
  const { sqlite } = createDb(dbName);
  runMigrations(sqlite, migDir);
  seed(sqlite);
  for (const f of files.filter((f) => f >= "0021")) copyFileSync(join(repo, f), join(migDir, f));
  try {
    runMigrations(sqlite, migDir);
    return { ok: true, err: "", sqlite };
  } catch (e) {
    sqlite.close();
    rmSync(migDir, { recursive: true, force: true });
    return { ok: false, err: e instanceof Error ? e.message : String(e), sqlite: null as unknown as Database.Database };
  }
}

const now = "2026-01-01T00:00:00Z";

test("空格/裸号/+86 手机号都能迁移成 +86 E.164；‘用户’转 onboarding", async () => {
  const r = await upgrade((s) => {
    s.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('U1','+8613800000001','x','Abc',?,?)").run(now, now);
    s.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('U2','138 0000 0002','x','用户',?,?)").run(now, now);
    s.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('U3','86 13900000003','x','小明',?,?)").run(now, now);
  });
  assert.equal(r.ok, true, r.err);
  try {
    const u1 = r.sqlite.prepare("SELECT phone,nickname,nickname_key,profile_completed_at FROM users WHERE id='U1'").get() as Record<string, unknown>;
    const u2 = r.sqlite.prepare("SELECT phone,nickname,profile_completed_at FROM users WHERE id='U2'").get() as Record<string, unknown>;
    const u3 = r.sqlite.prepare("SELECT phone,nickname FROM users WHERE id='U3'").get() as Record<string, unknown>;
    assert.equal(u1.phone, "+8613800000001");
    assert.equal(u2.phone, "+8613800000002");
    assert.equal(u3.phone, "+8613900000003");
    assert.equal(u2.nickname, null, "‘用户’应转 onboarding");
    assert.equal(u2.profile_completed_at, null);
    assert.equal(u1.nickname, "Abc");
    assert.equal(u1.nickname_key, "abc");
  } finally {
    r.sqlite.close();
  }
});

test("非法手机号（邮箱账号）→ 0021 显式中止", async () => {
  const r = await upgrade((s) => {
    s.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('Ue','a@b.com','x','E',?,?)").run(now, now);
  });
  assert.equal(r.ok, false, "应中止迁移，而不是静默通过");
  assert.match(r.err, /非大陆手机号|无法按 \+86 E\.164 解析|0021/, "中止信息应明确: " + r.err);
});

test("非法 +86（+86 + 非大陆号）→ 0021 显式中止", async () => {
  const r = await upgrade((s) => {
    s.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('U1','+8623456','x','A',?,?)").run(now, now);
  });
  assert.equal(r.ok, false, "非法 +86 应中止");
  assert.match(r.err, /0021|非大陆手机号/, r.err);
});

test("大小写冲突昵称（NFKC 判定近似）→ 0021 显式中止而不是静默错位", async () => {
  const r = await upgrade((s) => {
    s.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('U1','13800000001','x','Abc',?,?)").run(now, now);
    s.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('U2','13800000002','x','ABC',?,?)").run(now, now);
  });
  assert.equal(r.ok, false, "归一冲突应中止");
  assert.match(r.err, /冲突|0021/, "冲突信息应明确: " + r.err);
});

test("全角昵称（NFKC 不稳定）→ 转入 onboarding，不产生错误 key", async () => {
  const r = await upgrade((s) => {
    // U+FF21 全角 A：非 ASCII/CJK 稳定字符 → 路由 onboarding（NULL），避免错误归一冲突
    s.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('U1','13800000001','x','\uFF21bc',?,?)").run(now, now);
  });
  assert.equal(r.ok, true, "全角昵称应安全路由到 onboarding 而非中止: " + r.err);
  try {
    const u = r.sqlite.prepare("SELECT nickname,profile_completed_at FROM users WHERE id='U1'").get() as Record<string, unknown>;
    assert.equal(u.nickname, null, "全角昵称应转入 onboarding");
    assert.equal(u.profile_completed_at, null);
  } finally {
    r.sqlite.close();
  }
});

test("旧 family_members 含 viewer → 0022 显式中止（不静默提权为 member）", async () => {
  const r = await upgrade((s) => {
    s.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('U1','13800000001','x','A',?,?)").run(now, now);
    s.prepare("INSERT INTO families (id,name,owner_user_id,created_at,updated_at) VALUES ('F1','家','U1',?,?)").run(now, now);
    s.prepare("INSERT INTO family_members (id,family_id,user_id,role,is_active,joined_at) VALUES ('M1','F1','U1','viewer',1,?)").run(now);
  });
  assert.equal(r.ok, false, "含 viewer 的旧家庭数据应中止 0022");
  assert.match(r.err, /0022|viewer\/admin/, "中止信息应明确: " + r.err);
});

test("存量旧邀请 → 0022 显式中止（不静默删除邀请）", async () => {
  const r = await upgrade((s) => {
    s.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('U1','13800000001','x','A',?,?)").run(now, now);
    s.prepare("INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES ('U2','13800000002','x','B',?,?)").run(now, now);
    s.prepare("INSERT INTO families (id,name,owner_user_id,created_at,updated_at) VALUES ('F1','家','U1',?,?)").run(now, now);
    s.prepare("INSERT INTO family_members (id,family_id,user_id,role,is_active,joined_at) VALUES ('M1','F1','U1','owner',1,?)").run(now);
    s.prepare("INSERT INTO family_invitations (id,family_id,inviter_user_id,target_account_hash,role,token_hash,status,expires_at,created_at,updated_at) VALUES ('I1','F1','U1','hash','member','tok','pending','2030-01-01T00:00:00Z',?,?)").run(now, now);
  });
  assert.equal(r.ok, false, "存量旧邀请应中止 0022（而非静默删除）");
  assert.match(r.err, /0022|存量邀请|target_account_hash/, "中止信息应明确: " + r.err);
});
