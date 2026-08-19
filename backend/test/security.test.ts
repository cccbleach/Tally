import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let sqlite: Awaited<ReturnType<typeof import("../src/db/client.js")["createDb"]>>["sqlite"];
let dir: string;

// 在导入 server/config 之前注入环境变量，确保 CORS 白名单按本测试的配置加载
process.env.CORS_ORIGINS = "http://allowed.example.com";

before(async () => {
  const { createDb } = await import("../src/db/client.js");
  const { runMigrations } = await import("../src/db/runner.js");
  const { buildApp } = await import("../src/server.js");
  dir = mkdtempSync(join(tmpdir(), "tally-sec-"));
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

test("CORS：白名单源被放行，未列入的源不放行", async () => {
  const ok = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "http://allowed.example.com" },
  });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.headers["access-control-allow-origin"], "白名单源应得到 CORS 头");

  const denied = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "http://other.example.com" },
  });
  assert.equal(denied.headers["access-control-allow-origin"], undefined, "未列入源不应得到 CORS 头");
});

test("登录接口超出阈值返回 429", async () => {
  const attempts = [];
  for (let i = 0; i < 4; i++) {
    attempts.push(
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "x@example.com", password: "wrong" },
      }),
    );
  }
  assert.notEqual(attempts[0]!.statusCode, 429, "前 3 次不应被限流");
  assert.equal(attempts[3]!.statusCode, 429, "第 4 次应触发限流");
  assert.equal(attempts[3]!.json().error.code, "RATE_LIMITED");
});
