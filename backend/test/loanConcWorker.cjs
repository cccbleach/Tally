// 并发测试专用 worker（CommonJS 版）：在独立线程中启动一个真实的 Fastify App + 独立 SQLite 连接。
//
// 为什么是 .cjs 而不是 .ts：
//   测试/开发环境由 tsx 注入 ESM loader（--import loader.mjs），worker 线程继承后，
//   Node 会在 worker 内通过 ESM loader 的 getSourceSync 读取入口文件，把 fd 标成
//   “unmanaged mode”，从而批量打印 “File descriptor ... opened/closed in unmanaged mode”。
//   本 worker 改为纯 CommonJS（.cjs）入口，并只继承 tsx 的 CJS require 钩子
//   （execArgv: [--require, tsx/cjs]，在 test 里注入），完全不走 ESM loader，
//   因此**不存在**上述 FD 告警；同时仍能用 require() 加载 TypeScript 源码（显式 .ts 扩展）。
//
// 两个 worker 各自监听随机端口，主测试线程同时对两者发起真正并发的 HTTP 请求，
// 以验证数据库级幂等认领（UNIQUE 索引）在真实并发下的行为。
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
// 显式 .ts 扩展：tsx 的 CJS require 钩子（tsx/cjs）会按 TS 编译加载；不写 .js 是为了
// 不经 ESM loader（写 .js 会走 ESM 对 .js→.ts 的解析，反而绕回 getSourceSync 告警路径）。
const { createDb } = require("../src/db/client.ts");
const { buildApp } = require("../src/server.ts");

async function main() {
  const { dbFile, jwtSecret } = workerData;
  const { db, sqlite } = createDb(dbFile);
  try {
    const app = await buildApp({ db, jwtSecret });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const actualPort = typeof addr === "object" && addr !== null ? addr.port : 0;
    parentPort.postMessage({ ready: true, port: actualPort });
    // 保持 worker 存活：HTTP server 监听中即不会退出
  } catch (e) {
    parentPort.postMessage({ error: e instanceof Error ? e.message : String(e) });
    try {
      sqlite.close();
    } catch {
      /* ignore */
    }
  }
}

void main();
