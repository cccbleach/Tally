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
| `PORT` | 8080 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `DATABASE_URL` | ./data/tally.db | SQLite 文件路径 |
| `JWT_SECRET` | dev-secret-change-me | JWT 签名密钥，**生产必须改**（缺省时生产模式直接拒绝启动） |
| `APP_TIMEZONE` / `TZ` | Asia/Shanghai | 业务时区，决定“今天/当月”口径；建议保持与用户一致的时区 |
| `BASE_CURRENCY` | CNY | 基准币种，统计/总资产的统一换算口径 |
| `CORS_ORIGINS` | （空） | CORS 白名单，逗号分隔；为空则开发期放行所有。生产建议显式列出前端域名 |
| `AUTH_RATE_MAX`（预留） | 60/分钟 | 登录/注册接口限流阈值（当前默认 60；可通过部署配置调整） |
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

App 端 ATS 已收紧（`NSAllowsArbitraryLoads: false` + `NSAllowsLocalNetworking: true`，本地/局域网 HTTP 仍可开发调试）。生产环境请：

1. 用 Nginx/Caddy 反向代理并启用 TLS（如 Let's Encrypt）。
2. 将 App 的 `baseURL` 改为 `https://你的域名`。
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
