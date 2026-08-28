// 并发测试专用 worker：在独立线程中启动一个真实的 Fastify App + 独立 SQLite 连接。
// 两个 worker 各自监听随机端口，主测试线程同时对两者发起真正并发的 HTTP 请求，
// 以验证数据库级幂等认领（UNIQUE 索引）在真实并发下的行为。
import { parentPort, workerData } from "node:worker_threads";
import { createDb } from "../src/db/client.js";
import { buildApp } from "../src/server.js";

interface Payload {
  dbFile: string;
  jwtSecret: string;
}

async function main() {
  const { dbFile, jwtSecret } = workerData as Payload;
  const { db, sqlite } = createDb(dbFile);
  try {
    const app = await buildApp({ db, jwtSecret });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const actualPort = typeof addr === "object" && addr !== null ? addr.port : 0;
    parentPort!.postMessage({ ready: true, port: actualPort });
    // 保持 worker 存活：HTTP server 监听中即不会退出
  } catch (e) {
    parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) });
    try {
      sqlite.close();
    } catch {
      /* ignore */
    }
  }
}

void main();
