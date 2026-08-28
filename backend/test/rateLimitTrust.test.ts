import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let sqlite: Awaited<ReturnType<typeof import("../src/db/client.js")["createDb"]>>["sqlite"];
let dir: string;

// 独立进程/独立 app（限流阈值 3），确保 IP 桶未被其它测试占用。
process.env.CORS_ORIGINS = "http://allowed.example.com";

before(async () => {
  const { createDb } = await import("../src/db/client.js");
  const { runMigrations } = await import("../src/db/runner.js");
  const { buildApp } = await import("../src/server.js");
  dir = mkdtempSync(join(tmpdir(), "tally-rl-"));
  const created = createDb(join(dir, "test.db"));
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({
    db: created.db,
    jwtSecret: "test-secret",
    rateLimit: { max: 3, windowMs: 60_000 },
  });
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("默认不信任客户端伪造的 X-Forwarded-For：伪造不同 XFF 仍计入同一 IP 限流桶", async () => {
  const attempts = [];
  for (let i = 0; i < 4; i++) {
    attempts.push(
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { "x-forwarded-for": `10.0.0.${i + 100}` },
        payload: { email: "xff@example.com", password: "wrong" },
      }),
    );
  }
  assert.notEqual(attempts[0]!.statusCode, 429, "第 1 次不应被限流");
  assert.equal(attempts[3]!.statusCode, 429, "伪造不同 XFF 仍应命中同一 IP 限流桶");
});
