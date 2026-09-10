import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import cron from "node-cron";
import { config } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/runner.js";
import { buildApp } from "./server.js";
import { runDueRecurring } from "./lib/recurringRunner.js";
import { makeJwt } from "./auth/jwt.js";
import { makeAuthService } from "./auth/service.js";

const dbPath = resolve(config.databaseUrl);
mkdirSync(dirname(dbPath), { recursive: true });
const { db, sqlite } = createDb(dbPath);
runMigrations(sqlite, resolve("./migrations"));

// 启动时补跑周期账单
try {
  const n = runDueRecurring(db);
  if (n > 0) console.log("已补跑周期账单 " + n + " 笔");
} catch (e) {
  console.error("补跑周期账单失败:", e);
}

const app = await buildApp({ db, jwtSecret: config.jwtSecret });
await app.listen({ port: config.port, host: config.host });
console.log("Tally 后端已启动: http://" + config.host + ":" + config.port);

// 每日 00:05 补跑周期账单 + 清理过期会话/onboarding ticket
cron.schedule(
  "5 0 * * *",
  () => {
    try {
      runDueRecurring(db);
    } catch (e) {
      console.error("周期账单调度失败:", e);
    }
    try {
      const pruned = makeAuthService(db, makeJwt(config.jwtSecret)).pruneExpiredAuthArtifacts();
      if (pruned.sessions > 0 || pruned.tickets > 0) {
        console.log(`已清理过期会话 ${pruned.sessions} 条、onboarding ticket ${pruned.tickets} 条`);
      }
    } catch (e) {
      console.error("清理过期会话失败:", e);
    }
  },
  // 显式指定业务时区：原先只跟随容器 TZ，当 APP_TIMEZONE 与 TZ 不一致时会算错"今天"
  { timezone: config.timezone },
);

// 优雅关闭：收到 SIGTERM/SIGINT 时停止接收新请求、关闭 SQLite（避免 WAL 半写与句柄泄漏）
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，开始优雅关闭…`);
  try {
    await app.close();
  } catch (e) {
    console.error("关闭 HTTP 服务失败:", e);
  }
  try {
    sqlite.close();
  } catch (e) {
    console.error("关闭数据库失败:", e);
  }
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
