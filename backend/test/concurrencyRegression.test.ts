import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { users, familyMembers, familyInvitations } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { smsRegister, authHeaders } from "./helpers.js";

// 回归：真实并发下的业务冲突必须返回业务 409，不能泄漏 SQLite 500。
// - 两个独立 App 实例 + 两个独立 SQLite 连接，同时接受不同家庭的邀请：
//   只有一方成功，另一方必须 409（ALREADY_IN_FAMILY），不能 500。
// - 两个独立实例同时 complete-profile 撞同名昵称：一方 200，另一方 409 NICKNAME_TAKEN，不能 500。

const tsxCjsRequireHook = createRequire(import.meta.url).resolve("tsx/cjs");
process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";

const JWT_SECRET = "concurrency-reg-secret-0123456789";
let dir: string;
let dbFile: string;
let workerA: Worker;
let workerB: Worker;
let portA = 0;
let portB = 0;

let targetToken = "";
let targetId = "";
let inviteA = "";
let inviteB = "";
let n1Token = "";
let n2Token = "";

function httpPost(port: number, path: string, token: string | null, body: unknown): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, text: await r.text() }));
}

function spawnServer(): Promise<{ worker: Worker; port: number }> {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(new URL("./concurrencyWorker.cjs", import.meta.url), {
      workerData: { dbFile, jwtSecret: JWT_SECRET },
      execArgv: ["--require", tsxCjsRequireHook],
    });
    const timer = setTimeout(() => reject(new Error("worker 启动超时")), 15000);
    worker.once("message", (msg: { ready?: boolean; error?: string; port?: number }) => {
      clearTimeout(timer);
      if (msg?.ready && typeof msg.port === "number") resolvePromise({ worker, port: msg.port });
      else reject(new Error(msg?.error ?? "worker 启动失败"));
    });
    worker.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function requestCode(app: FastifyInstance, phone: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/api/v1/auth/request-code", headers: { "content-type": "application/json" }, payload: JSON.stringify({ phone }) });
  return r.json().code as string;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-conc-reg-"));
  dbFile = join(dir, "test.db");

  const created = createDb(dbFile);
  runMigrations(created.sqlite, resolve("./migrations"));
  const app = await buildApp({ db: created.db, jwtSecret: JWT_SECRET });
  const api = (headers: Record<string, string>, method: string, url: string, body?: unknown) => {
    const h = { ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    return app.inject({ method, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
  };

  // —— 家庭接受并发种子 ——
  const target = await smsRegister(app, "13876000001", "并发目标");
  targetToken = target.token;
  targetId = target.user.id;
  const th = authHeaders(target);
  const oa = await smsRegister(app, "13876000002", "甲家并发主");
  const ob = await smsRegister(app, "13876000003", "乙家并发主");
  const hA = authHeaders(oa);
  const hB = authHeaders(ob);

  const fa = (await api(hA, "POST", "/api/v1/families", { name: "并发甲家" })).json().item.id as string;
  const fb = (await api(hB, "POST", "/api/v1/families", { name: "并发乙家" })).json().item.id as string;
  inviteA = (await api(hA, "POST", `/api/v1/families/${fa}/invitations`, { nickname: "并发目标" })).json().item.id as string;
  inviteB = (await api(hB, "POST", `/api/v1/families/${fb}/invitations`, { nickname: "并发目标" })).json().item.id as string;

  // —— 同名昵称并发种子（两个未完成用户） ——
  for (const phone of ["13876000004", "13876000005"]) {
    const code = await requestCode(app, phone);
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login-code", headers: { "content-type": "application/json" }, payload: JSON.stringify({ phone, code }) });
    const body = login.json() as { onboardingToken: string };
    if (phone === "13876000004") n1Token = body.onboardingToken;
    else n2Token = body.onboardingToken;
  }
  assert.ok(n1Token && n2Token);

  await app.close();
  created.sqlite.close();

  const a = await spawnServer();
  workerA = a.worker;
  portA = a.port;
  const b = await spawnServer();
  workerB = b.worker;
  portB = b.port;
});

after(async () => {
  if (workerA) await workerA.terminate();
  if (workerB) await workerB.terminate();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("并发接受不同家庭邀请：一方 200，另一方业务 409（不泄漏 SQLite 500）", async () => {
  const [r1, r2] = await Promise.all([
    httpPost(portA, `/api/v1/families/invitations/${inviteA}/accept`, targetToken, {}),
    httpPost(portB, `/api/v1/families/invitations/${inviteB}/accept`, targetToken, {}),
  ]);
  const s1 = r1.status;
  const s2 = r2.status;
  assert.notEqual(s1, 500, "不应泄漏 500: " + r1.text);
  assert.notEqual(s2, 500, "不应泄漏 500: " + r2.text);
  // 恰好一个成功
  const successes = [s1, s2].filter((s) => s === 200).length;
  assert.equal(successes, 1, "并发接受不同家庭应恰好一个成功，实际 " + s1 + " / " + s2 + " -> " + r1.text + " / " + r2.text);
  const loser = s1 === 200 ? r2 : r1;
  assert.equal(loser.status, 409, "失败方必须为业务 409（不泄漏 500）: " + loser.text);
  const body = JSON.parse(loser.text) as { error?: { code?: string } };
  // 业务 409 即可：真实并发下可能命中「邀请已被处理」（胜者已撤销他者邀请），
  // 也可能命中单家庭唯一索引 ALREADY_IN_FAMILY；两者都不允许泄漏 SQLite 500。
  assert.ok(
    body.error?.code === "ALREADY_IN_FAMILY" || body.error?.code === "INVITATION_EXISTS",
    "失败方错误码应为 ALREADY_IN_FAMILY 或 INVITATION_EXISTS: " + loser.text,
  );

  // 数据层：目标只属于一个 active 家庭
  const v = createDb(dbFile);
  try {
    const active = v.db.select().from(familyMembers).all().filter((m) => m.isActive && m.userId === targetId);
    assert.equal(active.length, 1, "目标应仅属于一个 active 家庭");
  } finally {
    v.sqlite.close();
  }
});

test("并发 complete-profile 撞同名昵称：一方 200，另一方 409 NICKNAME_TAKEN（不泄漏 500）", async () => {
  const [r1, r2] = await Promise.all([
    httpPost(portA, "/api/v1/auth/complete-profile", null, { onboardingToken: n1Token, nickname: "并发撞名" }),
    httpPost(portB, "/api/v1/auth/complete-profile", null, { onboardingToken: n2Token, nickname: "并发撞名" }),
  ]);
  assert.notEqual(r1.status, 500, "不应泄漏 500: " + r1.text);
  assert.notEqual(r2.status, 500, "不应泄漏 500: " + r2.text);
  const successes = [r1.status, r2.status].filter((s) => s === 200).length;
  assert.equal(successes, 1, "并发同昵称应恰好一个成功: " + r1.status + "/" + r2.status + " -> " + r1.text + "/" + r2.text);
  const loser = r1.status === 200 ? r2 : r1;
  assert.equal(loser.status, 409, "失败方必须 409: " + loser.text);
  const body = JSON.parse(loser.text) as { error?: { code?: string } };
  assert.equal(body.error?.code, "NICKNAME_TAKEN", "失败方错误码应为 NICKNAME_TAKEN: " + loser.text);

  // 数据层：该昵称只出现一次
  const v = createDb(dbFile);
  try {
    const rows = v.db.select().from(users).all().filter((u) => u.nickname === "并发撞名");
    assert.equal(rows.length, 1, "数据库应只有一条并发撞名昵称");
  } finally {
    v.sqlite.close();
  }
});
