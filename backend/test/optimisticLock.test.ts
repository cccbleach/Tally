process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { smsRegister } from "./helpers.js";

// 账户/分类乐观锁回归（里程碑 P2）：
// 历史缺陷：只有流水/预算/周期账单支持 expectedUpdatedAt，家庭共享账本下
// 两台设备并发修改同一账户/分类会静默相互覆盖（Last-Write-Wins 且无任何感知）。
//
// 本文件锁死的不变量：
//   1) PATCH 带 expectedUpdatedAt 且与当前 updatedAt 不一致 → 409 CONFLICT；
//   2) 每次成功修改 updatedAt 前移（下一次带旧值必然冲突）；
//   3) 不带 expectedUpdatedAt → 维持 LWW 行为（兼容旧客户端，不是硬性要求）。
let app: FastifyInstance;
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;
let H: Record<string, string>;

function req(method: string, url: string, body?: unknown) {
  const h = { ...H };
  if (body !== undefined) h["content-type"] = "application/json";
  return app.inject({ method, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-optimistic-"));
  const created = createDb(join(dir, "tally.db"));
  sqlite = created.sqlite;
  runMigrations(sqlite, resolveMigrations());
  app = await buildApp({ db: created.db, jwtSecret: "x".repeat(40) });
  const body = await smsRegister(app, "+8613800000111", "乐观锁测试");
  H = { authorization: "Bearer " + body.token };
});

after(async () => {
  await app.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function resolveMigrations() {
  // 兼容从 test/ 与 backend/ 两种 cwd 运行
  const candidates = [resolve("./migrations"), resolve("../migrations")];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

test("账户 PATCH：expectedUpdatedAt 过期返回 409，成功修改会前移 updatedAt", async () => {
  const created = await req("POST", "/api/v1/accounts", { name: "微信钱包", type: "e-wallet", initialBalance: 0 });
  assert.equal(created.statusCode, 200, created.body);
  const accountId = created.json().item.id as string;
  const v1 = created.json().item.updatedAt as string;
  assert.ok(typeof v1 === "string" && v1.length > 0, "创建即应返回 updatedAt（存量回填为 created_at）");

  // 用 v1 版本号改一次 → 成功且 updatedAt 前移
  const first = await req("PATCH", `/api/v1/accounts/${accountId}`, { name: "钱包A", expectedUpdatedAt: v1 });
  assert.equal(first.statusCode, 200, first.body);
  const v2 = first.json().item.updatedAt as string;
  assert.notEqual(v1, v2, "成功修改必须前移 updatedAt");

  // 再用旧版本号 v1 改 → 409（模拟另一台设备持有过期数据）
  const stale = await req("PATCH", `/api/v1/accounts/${accountId}`, { name: "钱包B", expectedUpdatedAt: v1 });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "CONFLICT");

  // 不带版本号 → 兼容旧行为（LWW 直接成功）
  const lww = await req("PATCH", `/api/v1/accounts/${accountId}`, { name: "钱包C" });
  assert.equal(lww.statusCode, 200, lww.body);
  assert.equal(lww.json().item.name, "钱包C");
});

test("分类 PATCH：expectedUpdatedAt 过期返回 409", async () => {
  const created = await req("POST", "/api/v1/categories", { name: "餐饮", type: "expense" });
  assert.equal(created.statusCode, 200, created.body);
  const categoryId = created.json().item.id as string;
  const v1 = created.json().item.updatedAt as string;
  assert.ok(typeof v1 === "string" && v1.length > 0);

  const bump = await req("PATCH", `/api/v1/categories/${categoryId}`, { name: "吃喝", expectedUpdatedAt: v1 });
  assert.equal(bump.statusCode, 200, bump.body);
  assert.notEqual(bump.json().item.updatedAt, v1);

  const stale = await req("PATCH", `/api/v1/categories/${categoryId}`, { name: "被覆盖的名字", expectedUpdatedAt: v1 });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "CONFLICT");

  // 冲突方刷新后用新版本号重试成功（真实的用户恢复路径）
  const retry = await req("PATCH", `/api/v1/categories/${categoryId}`, {
    name: "吃喝",
    expectedUpdatedAt: bump.json().item.updatedAt,
  });
  assert.equal(retry.statusCode, 200, retry.body);
});
