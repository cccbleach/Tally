import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import cron from "node-cron";
import { config } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/runner.js";
import { buildApp } from "./server.js";
import { runDueRecurring } from "./lib/recurringRunner.js";

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

// 每日 00:05 补跑周期账单
cron.schedule("5 0 * * *", () => {
  try {
    runDueRecurring(db);
  } catch (e) {
    console.error("周期账单调度失败:", e);
  }
});
