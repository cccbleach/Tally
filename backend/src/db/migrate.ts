import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";
import { createDb } from "./client.js";
import { runMigrations } from "./runner.js";

const dbPath = resolve(config.databaseUrl);
mkdirSync(dirname(dbPath), { recursive: true });
const { sqlite } = createDb(dbPath);
runMigrations(sqlite, resolve("./migrations"));
sqlite.close();
console.log("数据库迁移完成: " + dbPath);
