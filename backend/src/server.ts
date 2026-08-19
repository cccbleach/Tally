import Fastify from "fastify";
import { sql } from "drizzle-orm";
import cors from "@fastify/cors";
import { errorHandler } from "./lib/errors.js";
import type { AppDb } from "./db/client.js";
import { config } from "./config.js";
import { makeJwt } from "./auth/jwt.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerAccountRoutes } from "./modules/accounts.js";
import { registerCategoryRoutes } from "./modules/categories.js";
import { registerTransactionRoutes } from "./modules/transactions.js";
import { registerBudgetRoutes } from "./modules/budgets.js";
import { registerRecurringRoutes } from "./modules/recurring.js";
import { registerStatsRoutes } from "./modules/stats.js";
import { createRateLimiter } from "./lib/rateLimit.js";
import { createOtpStore } from "./lib/otp.js";

export interface Deps {
  db: AppDb["db"];
  jwtSecret: string;
  rateLimit?: { windowMs?: number; max?: number };
}

export async function buildApp(deps: Deps) {
  // 日志：默认 warn 级别（避免测试噪音），生产可设 info/debug；off 关闭
  const app = Fastify({
    logger:
      config.logLevel === "off"
        ? false
        : { level: config.logLevel, serializers: { req: (r: { method: string; url: string; id: unknown }) => ({ method: r.method, url: r.url, id: r.id }) } },
  });

  // CORS：配置白名单则仅放行白名单源；未配置则开发期放行所有（iOS 客户端不受影响）
  const whitelist = config.corsOrigins;
  await app.register(cors, {
    origin:
      whitelist.length > 0
        ? (origin, cb) => {
            if (!origin || whitelist.includes(origin)) cb(null, true);
            else cb(new Error("CORS_NOT_ALLOWED"), false);
          }
        : true,
  });
  app.setErrorHandler(errorHandler);

  const jwt = makeJwt(deps.jwtSecret);
  const authLimiter = createRateLimiter({
    windowMs: deps.rateLimit?.windowMs ?? 60_000,
    max: deps.rateLimit?.max ?? 60,
  });
  const otp = createOtpStore();
  const shared = { db: deps.db, jwt, authLimiter, otp };

  app.get("/health", async () => {
    deps.db.all(sql`SELECT 1`); // 校验 DB 可达
    return { status: "ok", time: new Date().toISOString() };
  });

  registerAuthRoutes(app, shared);
  registerAccountRoutes(app, shared);
  registerCategoryRoutes(app, shared);
  registerTransactionRoutes(app, shared);
  registerBudgetRoutes(app, shared);
  registerRecurringRoutes(app, shared);
  registerStatsRoutes(app, shared);

  return app;
}
