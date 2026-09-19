process.env.ALIYUN_SMS_ENABLED = "false";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { users, ledgers, categories } from "../src/db/schema.js";
import { categoryNameMap } from "../src/repositories/categoryRepository.js";
import { loadRelationMaps } from "../src/services/transactionService.js";

let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;
let userId: string;
let ledgerA: string;
let ledgerB: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "tally-repo-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));

  userId = randomUUID();
  ledgerA = randomUUID();
  ledgerB = randomUUID();
  const now = new Date().toISOString();
  db.insert(users).values({
    id: userId,
    phone: "+8613900000001",
    nickname: "repo",
    nicknameKey: "repo",
    phoneVerifiedAt: now,
    nicknameChangedAt: now,
    profileCompletedAt: now,
    defaultLedgerId: ledgerA,
    currentLedgerId: ledgerA,
    createdAt: now,
    updatedAt: now,
  }).run();
  for (const [id, name] of [[ledgerA, "账本A"], [ledgerB, "账本B"]] as const) {
    db.insert(ledgers).values({ id, userId, name, isDefault: id === ledgerA, createdAt: now, updatedAt: now }).run();
  }
  const catA = randomUUID();
  const catB = randomUUID();
  db.insert(categories).values({ id: catA, userId, ledgerId: ledgerA, name: "A分类", type: "expense", createdAt: now, updatedAt: now }).run();
  db.insert(categories).values({ id: catB, userId, ledgerId: ledgerB, name: "B分类", type: "expense", createdAt: now, updatedAt: now }).run();
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("loadRelationMaps 仅返回指定账本的数据（不经过 HTTP）", () => {
  const mapsA = loadRelationMaps(db, userId, ledgerA);
  assert.equal(mapsA.cm.size, 1);
  assert.equal([...mapsA.cm.values()][0]!.name, "A分类");

  const mapsB = loadRelationMaps(db, userId, ledgerB);
  assert.equal(mapsB.cm.size, 1);
  assert.equal([...mapsB.cm.values()][0]!.name, "B分类");
});

test("categoryNameMap 按账本隔离", () => {
  assert.equal(categoryNameMap(db, userId, ledgerB).get([...categoryNameMap(db, userId, ledgerB).keys()][0]!), "B分类");
});
