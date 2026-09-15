import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isSmsLive } from "./lib/sms.js";

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
  /** 汇率自动拉取（默认关闭）：开启后每日拉取最新汇率写入全局兜底表 */
  exchangeRateFetchEnabled: boolean;
  exchangeRateFetchUrl: string;
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

// ---------- AUTH_MODE 互锁（安全关键，勿放宽） ----------
// 历史缺陷（已复现）：`AUTH_MODE` 原先是无校验的强制类型转换，且判定写作
// `config.authMode === "production"`，于是——
//   1) `NODE_ENV=production AUTH_MODE=development` → 明文回传验证码，可接管任意账号；
//   2) `AUTH_MODE=bogus`（拼错/大小写不一致）同样退化为开发模式，同样回传验证码；
//   3) `NODE_ENV` 未设置（裸 `node dist/index.js`、systemd）默认开发模式，同样回传。
// 因此这里把「合法值域」「生产互锁」都做成启动期硬失败，而不是静默降级。
const rawAuthMode = (process.env.AUTH_MODE ?? "").trim().toLowerCase();
if (rawAuthMode && rawAuthMode !== "production" && rawAuthMode !== "development") {
  throw new Error(
    `AUTH_MODE 取值非法："${process.env.AUTH_MODE}"。只接受 "production" 或 "development"（大小写不敏感）。` +
      "拼写错误会导致验证码明文回传，因此这里拒绝启动而不是静默降级。",
  );
}
const authMode: Config["authMode"] = (rawAuthMode || (isProduction ? "production" : "development")) as Config["authMode"];
if (isProduction && authMode !== "production") {
  throw new Error(
    "生产环境（NODE_ENV=production）禁止 AUTH_MODE=development：该组合会把短信验证码明文回传给请求方，" +
      "任何人只要知道手机号即可登录他人账号。请改为 AUTH_MODE=production（或移除该变量使用默认值），" +
      "未满足条件将拒绝启动。",
  );
}

// 生产环境禁止关闭限流：DISABLE_RATE_LIMIT 是本地调试开关，若被带上生产，
// 登录/验证码接口将失去唯一的滥用防线（已实测 70 次请求 0 个 429）。
if (isProduction && process.env.DISABLE_RATE_LIMIT === "true") {
  throw new Error(
    "生产环境（NODE_ENV=production）禁止 DISABLE_RATE_LIMIT=true：登录与验证码接口将完全失去限流保护。" +
      "如确需在预发环境调试，请显式设置 NODE_ENV=development。",
  );
}

// 开发模式 + 真实短信凭据 = 最危险的组合：既能真实外呼产生费用，又把验证码回传给请求方。
// 本地开发与测试需要回传验证码，因此不阻断，只做醒目告警（测试运行时静默，避免刷屏）。
if (!isProduction && authMode === "development" && isSmsLive() && !process.env.NODE_TEST_CONTEXT) {
  console.warn(
    "[config] 警告：当前为开发模式（验证码会回传客户端），但已配置真实短信凭据（可真实外呼计费）。" +
      "该组合仅限本机调试，切勿用于任何对外可访问的部署；生产请设置 NODE_ENV=production 且 AUTH_MODE=production。",
  );
}

// 非 CNY 基准部署的静默算错风险（已实测复现）：
// 内置兜底汇率表是**人民币视角**（CNY 基准），而 getRate 按 config.baseCurrency 查表。
// 若 BASE_CURRENCY 配成别的币种且没有对应基准的汇率数据，查表失败就会回退到这张 CNY 基准的表，
// 被当成目标基准使用 —— 实测 getRate(JPY→USD) 返回 0.05（CNY/JPY）而非 0.00646，偏差约 7.7 倍
// （正好是 USD/CNY 的倍数），且不报任何错。这里做启动期告警，提示必须用与基准一致的汇率源。
const baseCurrency = (process.env.BASE_CURRENCY ?? "CNY").toUpperCase();
if (baseCurrency !== "CNY" && !process.env.NODE_TEST_CONTEXT) {
  console.warn(
    `[config] 警告：BASE_CURRENCY=${baseCurrency}，但内置兜底汇率表是人民币（CNY）视角。` +
      "若未提供该基准的汇率数据，换算会静默按 CNY 汇率计算（实测偏差可达数倍）。" +
      `请开启 EXCHANGE_RATE_FETCH_ENABLED=1 并使用与基准一致的汇率源（如 https://open.er-api.com/v6/latest/${baseCurrency}），` +
      "抓取会自动把汇率归一化到该基准。",
  );
}

export const config: Config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL ?? "./data/tally.db",
  jwtSecret,
  // 业务时区：用于“今天/当月”判断。优先 APP_TIMEZONE，其次容器 TZ，默认神州时间。
  timezone: process.env.APP_TIMEZONE ?? process.env.TZ ?? DEFAULT_TIMEZONE,
  // 基准币种：统计/总资产换算的统一口径，默认人民币。取值与告警见文件上方。
  baseCurrency,
  // 汇率自动拉取：默认关闭（自部署不强制依赖外部服务）。
  // 开启（EXCHANGE_RATE_FETCH_ENABLED=1）后启动 30s 拉一次 + 每日 04:30 定时刷新，
  // 结果 upsert 到全局兜底汇率（userId IS NULL），失败只记日志、绝不删除已有汇率。
  exchangeRateFetchEnabled: process.env.EXCHANGE_RATE_FETCH_ENABLED === "1",
  exchangeRateFetchUrl: process.env.EXCHANGE_RATE_FETCH_URL ?? "https://open.er-api.com/v6/latest/CNY",
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
  // 认证模式：生产模式下验证码永不回传、不写日志、失败不降级为明文；开发模式才允许固定/回传验证码。
  // 取值已在文件上方校验并与 NODE_ENV 做互锁，此处只做赋值。
  authMode,
  isProduction,
  // 可信代理层数：仅当部署在反向代理（如 Caddy/Nginx）之后才设置。
  // 用于从 X-Forwarded-For 取“真实客户端 IP”；默认 0 表示不信任任何 XFF。
  trustedProxyCount: Math.max(0, Number(process.env.TRUST_PROXY ?? 0) || 0),
  enableRateLimit: process.env.DISABLE_RATE_LIMIT !== "true",
};
