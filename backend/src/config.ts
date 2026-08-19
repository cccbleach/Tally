import { existsSync } from "node:fs";
import { resolve } from "node:path";

// 加载 .env（若存在）。Node 20.12+ 内置，无需 dotenv 依赖。
try {
  if (existsSync(resolve(".env"))) {
    process.loadEnvFile(resolve(".env"));
  }
} catch {
  // 忽略加载失败，使用默认值
}

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  timezone: string;
  baseCurrency: string;
  corsOrigins: string[];
  accessTokenTtl: string;
  refreshTokenTtl: string;
  logLevel: string;
}

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

export const DEFAULT_JWT_SECRET = "dev-secret-change-me";

const isProduction = process.env.NODE_ENV === "production";
const jwtSecret = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET;
if (isProduction && jwtSecret === DEFAULT_JWT_SECRET) {
  throw new Error(
    "生产环境缺少强随机 JWT_SECRET。请设置环境变量 JWT_SECRET（例如 `openssl rand -hex 32`），" +
      "未显式配置将拒绝启动，避免使用可预测的默认密钥。",
  );
}

export const config: Config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL ?? "./data/tally.db",
  jwtSecret,
  // 业务时区：用于“今天/当月”判断。优先 APP_TIMEZONE，其次容器 TZ，默认神州时间。
  timezone: process.env.APP_TIMEZONE ?? process.env.TZ ?? DEFAULT_TIMEZONE,
  // 基准币种：统计/总资产换算的统一口径，默认人民币。
  baseCurrency: (process.env.BASE_CURRENCY ?? "CNY").toUpperCase(),
  // CORS 白名单，逗号分隔；为空时开发环境放行所有（origin: true）。
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // JWT 有效期：访问令牌短、刷新令牌长
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  refreshTokenTtl: process.env.REFRESH_TOKEN_TTL ?? "30d",
  // 日志级别：可配置 info/debug/warn/error；off 表示关闭 Fastify logger
  logLevel: process.env.LOG_LEVEL ?? "warn",
};
