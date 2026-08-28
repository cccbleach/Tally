# 部署指南

Tally 后端为单文件 SQLite + Node.js 服务，部署极简。任选其一：

## 方式一：Docker（推荐）

在 `backend/` 目录下：

```bash
cd backend
JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

- 服务监听 `8080` 端口
- 数据持久化在 Docker 卷 `tally-data`（宿主对应 `/app/data/tally.db`）

> **单实例限制**：当前周期账单生成与进程内限流基于单进程 SQLite；请勿横向多实例共享同一
> SQLite 文件（如需多实例，先将数据库迁移到 PostgreSQL/MySQL 等共享存储，或加分布式锁）。

## 方式二：直接运行

```bash
cd backend
cp .env.example .env        # 编辑 JWT_SECRET 等配置
pnpm install
pnpm build
node dist/index.js
```

## 方式三：pm2 常驻

```bash
cd backend
pnpm install && pnpm build
pm2 start dist/index.js --name tally-backend
pm2 save
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `NODE_ENV` | （空） | 设为 `production` 启用严格安全校验 |
| `PORT` | 8080 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `DATABASE_URL` | ./data/tally.db | SQLite 文件路径 |
| `JWT_SECRET` | dev-local-only-not-for-production | JWT 签名密钥。**生产必须为 ≥32 位强随机且非占位值**，否则生产模式直接拒绝启动（`openssl rand -hex 32`） |
| `APP_TIMEZONE` / `TZ` | Asia/Shanghai | 业务时区，决定“今天/当月”口径；建议保持与用户一致的时区 |
| `BASE_CURRENCY` | CNY | 基准币种，统计/总资产的统一换算口径 |
| `CORS_ORIGINS` | （空） | CORS 白名单，逗号分隔。开发为空放行所有；**生产为空则不放行任意 Origin**，生产务必显式列出前端域名 |
| `TRUST_PROXY` | 0 | 可信反向代理层数；部署在反代后才设置，用于从 `X-Forwarded-For` 还原客户端 IP 做限流。默认不信任客户端伪造的 XFF |
| `DISABLE_RATE_LIMIT` | false | 关闭认证限流（不建议生产） |
| `AUTH_RATE_MAX`（预留） | 60/分钟 | 登录/注册/验证码/忘记密码接口限流阈值（IP + 账号双维度；当前默认 60） |
| `ACCESS_TOKEN_TTL` | 15m | 访问令牌有效期（如 `15m`、`1h`） |
| `REFRESH_TOKEN_TTL` | 30d | 刷新令牌有效期（如 `30d`、`90d`） |
| `ALIYUN_SMS_ENABLED` | false | 开启阿里云短信验证码；未开启时验证码直接返回（开发模式） |
| `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` | - | 阿里云 AccessKey（也可用 `ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET`） |
| `ALIYUN_SMS_SIGN_NAME` / `ALIYUN_SMS_TEMPLATE_CODE` | - | 短信签名与模板 code（模板参数用 `{"code","min"}`） |

## 数据备份

直接备份 SQLite 文件即可（连同 `-wal`/`-shm`，或备份前先停服）：

```bash
sqlite3 data/tally.db ".backup 'backup.db'"
```

建议用仓库内的 `scripts/backup.sh` 并配合 cron 每日备份（保留最近 14 份）：

```bash
0 3 * * * /path/to/Tally/scripts/backup.sh /path/to/data/tally.db /path/to/backups >> /var/log/tally-backup.log 2>&1
```

## 上线 HTTPS（重要）

App 端 ATS 已收紧（不再使用全局 `NSAllowsArbitraryLoads`，仅保留 `NSAllowsLocalNetworking` 供本地/局域网 HTTP 联调），且 API 地址由**构建配置注入**：

- `ios/project.yml` 的 `configs.Debug/Release.TALLY_API_BASE_URL` 定义各配置的地址（Debug 默认 `http://localhost:8080`，Release 默认 `https://your-production-domain.example.com`）。
- `Info.plist` 的 `TallyAPIBaseURL` 引用 `$(TALLY_API_BASE_URL)`，由 Xcode 构建时替换；`APIClient` 读取该键。
- `APIClient`（Release/#if !DEBUG）会**强制校验 HTTPS**：若注入的不是 `https://` 地址将直接 `fatalError` 拒绝启动，杜绝明文生产流量。

生产环境请：

1. 用 Nginx/Caddy 反向代理并启用 TLS（如 Let's Encrypt），并设置后端 `TRUST_PROXY=1`。
2. 将 Release 构建配置 `TALLY_API_BASE_URL` 改为 `https://你的域名`（可用 Xcode 的用户自定义构建设置或 `xcodebuild ... TALLY_API_BASE_URL=https://你的域名` 覆盖）。
3. 如需更严格，可进一步证书锁定（pinning）并移除 `NSAllowsLocalNetworking`。

Nginx 反代示例：

```nginx
server {
    listen 443 ssl;
    server_name tally.example.com;
    ssl_certificate     /etc/letsencrypt/live/tally.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tally.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 账单导入（Excel/xlsx）资源限制

- xlsx（Excel）解析运行在 **worker 线程** 中（`backend/src/lib/xlsxWorker.ts`），并施加资源限制：
  - 内存：worker 堆上限（旧代 64MB / 新生代 16MB）。
  - 超时：单次解析 20s 超时，超时强制 `terminate()` 并返回明确错误；若 worker 在任何结果返回前就退出，Promise 也会被 reject（不会留下永不完成的调用）。
  - 输入：文件大小 ≤5MB（上传层另有 20MB 总量限制）。
  - 输出：返回行数 ≤100,000、列数 ≤256、返回单元格总数 ≤500,000。
  - 并发：同一进程内同时最多运行 4 个解析 worker（超出排队等待），防止并发上传瞬时打满 CPU/内存。
- **重要：worker 线程不是进程级硬隔离。** 它与主进程共享同一个地址空间与文件描述符表，仅提供独立的 V8 堆 / 事件循环 / 崩溃边界；恶意代码仍可能在理论上影响同一进程的其他线程（共享进程级状态、文件描述符等）。真正“进程级硬隔离”需要 `child_process`（独立进程），本方案未采用。
- **残余风险**：worker 内的 zip 解压仍会先整份放入内存，若遇到“超高压缩比+超大”的构造文件，可能在 64MB 堆内触发 OOM（仅终止该 worker，通常不影响主进程）。如需更强隔离，可进一步先在子进程解压/限流，或对解压后流式分块校验；当前 5MB 输入上限 + 并发/行/单元格上限 + worker 内存/超时已把影响范围收窄。
