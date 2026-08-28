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
  authMode: "production" | "development";
  isProduction: boolean;
  trustedProxyCount: number;
  enableRateLimit: boolean;
}

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

export const DEFAULT_JWT_SECRET = "dev-secret-change-me";

const isProduction = process.env.NODE_ENV === "production";
const jwtSecret = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET;

// 生产环境必须使用强随机 JWT_SECRET：拒绝示例/占位/过短密钥。
// 已知示例与占位值列表（小写比较，去除首尾空白）。
const INSECURE_JWT_SECRETS = new Set(
  [
    DEFAULT_JWT_SECRET,
    "dev-secret",
    "change-me",
    "change-me-to-a-long-random-secret",
    "please-change-me",
    "please-change-me-to-a-long-random-string",
    "secret",
    "your-secret",
    "change_me",
    "changeme",
    "0123456789",
  ].map((s) => s.toLowerCase()),
);
function isStrongJwtSecret(secret: string): boolean {
  const t = secret.trim();
  if (t.length < 32) return false;
  if (INSECURE_JWT_SECRETS.has(t.toLowerCase())) return false;
  // 排除明显的占位符（变换大小写去掉空格后仍匹配）
  return !/^(change[-_ ]?me|please[-_ ]?change[-_ ]?me|your[-_ ]?(secret|key)|dev[-_ ]?secret|secret|placeholder|example|test)[A-Za-z0-9_\- ]*$/i.test(t.replace(/\s+/g, ""));
}
if (isProduction && !isStrongJwtSecret(jwtSecret)) {
  throw new Error(
    "生产环境必须配置强随机 JWT_SECRET（至少 32 位，且不能是示例/占位密钥）。" +
      "请设置环境变量 JWT_SECRET（例如 `openssl rand -hex 32`），未满足条件将拒绝启动。",
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
  // 认证模式：生产模式下验证码永不回传、不写日志、失败不降级为明文；开发模式才允许固定/回传验证码
  authMode: (process.env.AUTH_MODE as Config["authMode"] | undefined) ?? (isProduction ? "production" : "development"),
  isProduction,
  // 可信代理层数：仅当部署在反向代理（如 Caddy/Nginx）之后才设置。
  // 用于从 X-Forwarded-For 取“真实客户端 IP”；默认 0 表示不信任任何 XFF。
  trustedProxyCount: Math.max(0, Number(process.env.TRUST_PROXY ?? 0) || 0),
  enableRateLimit: process.env.DISABLE_RATE_LIMIT !== "true",
};
