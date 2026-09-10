// 与 .github/workflows/ci.yml 中「生产 compose 必须钉住 AUTH_MODE=production」步骤一致的断言。
// 用法: node scripts/check-compose-auth-mode.mjs <rendered.json> [显示名]
//
// 背景（已实测复现的安全缺陷）：AUTH_MODE=development 时 /auth/request-code 会把短信验证码
// 明文回传给请求方，任何人只要知道手机号即可调用 /auth/login-code 登录该账号（含已注册老用户）。
// 因此生产编排必须显式钉住 AUTH_MODE=production，且不得关闭限流。
// backend/src/config.ts 里另有一道启动期互锁（NODE_ENV=production + 非 production 直接拒绝启动），
// 本脚本守的是「部署声明层」，两者互为补充：谁能绕过一道，都过不了另一道。
import fs from "node:fs";

const file = process.argv[2];
const label = process.argv[3] ?? file;
if (!file) {
  console.error("用法: node scripts/check-compose-auth-mode.mjs <rendered.json> [显示名]");
  process.exit(2);
}

const rendered = JSON.parse(fs.readFileSync(file, "utf8"));
const backend = rendered.services?.["tally-backend"];
if (!backend) throw new Error(`${label}: 缺少 tally-backend 服务定义`);

// compose 渲染后 environment 可能是数组（KEY=VALUE）或对象，统一成对象
const rawEnv = backend.environment ?? {};
const env = Array.isArray(rawEnv)
  ? Object.fromEntries(
      rawEnv.map((entry) => {
        const idx = String(entry).indexOf("=");
        return idx === -1 ? [String(entry), null] : [String(entry).slice(0, idx), String(entry).slice(idx + 1)];
      }),
    )
  : rawEnv;

const nodeEnv = env.NODE_ENV;
const authMode = env.AUTH_MODE;

if (nodeEnv !== "production") {
  throw new Error(`${label}: tally-backend 的 NODE_ENV 必须是 production，实际 ${JSON.stringify(nodeEnv)}`);
}
if (authMode !== "production") {
  throw new Error(
    `${label}: 必须显式钉住 AUTH_MODE=production，实际 ${JSON.stringify(authMode)}` +
      "（development/缺省都会明文回传短信验证码，导致任意账号接管）",
  );
}
if (env.DISABLE_RATE_LIMIT !== undefined) {
  throw new Error(`${label}: 生产 compose 不得设置 DISABLE_RATE_LIMIT（登录/验证码将失去限流）`);
}

console.log(`✅ ${label}: NODE_ENV=production + AUTH_MODE=production（未关闭限流）`);
