# 部署指南

Tally 后端为单文件 SQLite + Node.js 服务，部署极简。**先按「80/443 在谁手里」选一种，不要混用**：

| 场景 | 用哪种 |
|---|---|
| 主机上已有别的站点在用 Caddy（**当前生产环境即如此**） | 方式一：裸机 + systemd + 共享 Caddy（详见 [production-deploy.md](production-deploy.md)） |
| 机器为 Tally 独占，想「一键含 HTTPS」 | 方式二：Docker Compose + Caddy（Caddy 独占宿主 80/443） |
| 只想要个常驻进程 / 临时跑 | 方式三/四：直接运行 / pm2（不含 TLS，需自行配反代） |

## 方式一：裸机 + systemd + 共享 Caddy（**当前生产环境使用**）

适合「主机上已经有一个 Caddy 在跑别的站点」的机器。⛔ **不要**在这类机器上跑下面的 compose：
它的 Caddy 会抢占宿主 80/443，把同机其他站点全部打掉。

完整步骤（systemd 单元与沙箱参数、发布/回滚、备份校验、共享 Caddy 站点片段）见
**[docs/production-deploy.md](production-deploy.md)**，最小流程：

```bash
# 1) 固定版本运行时与发布目录：/opt/tally/{releases,current,runtime}
#    current 是指向当前 release 的软链（systemd 的 WorkingDirectory）
# 2) 生产环境变量：/etc/tally/tally.env（0600 root:root，systemd EnvironmentFile 读取）
#    NODE_ENV=production  HOST=127.0.0.1  PORT=18080
#    DATABASE_URL=/var/lib/tally/tally.db  JWT_SECRET=<openssl rand -hex 32>
#    TRUST_PROXY=1  CORS_ORIGINS=https://<你的域名>  ALIYUN_SMS_*=<...>
# 3) systemd 单元：User=tally、ProtectSystem=strict、ReadWritePaths=/var/lib/tally、MemoryMax=1G
systemctl enable --now tally-backend
# 4) 现有（共享）Caddy 追加 site block：reverse_proxy 127.0.0.1:18080
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile   # 先备份 Caddyfile
systemctl reload caddy          # reload 而非 restart：不中断其他站点
# 5) 验收
curl -sS 127.0.0.1:18080/health/ready
curl -sS https://<你的域名>/health/ready
```

发布新版本 = 上传到 `/opt/tally/releases/<新id>` → `pnpm install --prod --frozen-lockfile`
→ `ln -sfn` + `mv -T` 原子替换 `current` → `systemctl restart tally-backend`；
**回滚就是把软链切回上一个 release 目录**（见 production-deploy.md 第 5 节）。

## 方式二：Docker（机器独占时的一键 HTTPS 方案）

### 生产（含 HTTPS）：Caddy + backend 一套起

```bash
cd backend
export TALLY_DOMAIN=your-domain.cn                   # 必填：已解析的域名（正式生产唯一域名）
export ACME_EMAIL=ops@example.com                 # 必填：证书联系邮箱 + 备用 CA 回退
export JWT_SECRET=$(openssl rand -hex 32)        # 必填：强随机
docker compose -f docker-compose.caddy.yml up -d --build
docker compose -f docker-compose.caddy.yml config --quiet   # 上线前校验
```

- 只有 Caddy 对宿主发布 **80/443**；后端 `tally-backend:8080` 只在 Docker 网络 `tally-edge` 内可达。
- 持久卷：`tally-data`（SQLite）、`caddy_data`（证书）、`caddy_config`。
- 两个服务都有 healthcheck 与 `restart: unless-stopped`；`TRUST_PROXY` 默认 1。
- `ACME_EMAIL` 非空时 Caddy 默认启用 Let's Encrypt 与 ZeroSSL 双 CA 自动回退。

### 内网/无域名（只跑后端，不含 HTTPS）

```bash
cd backend
JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

- 该 compose 也只 `expose` 8080（不对宿主发布端口）；需要从宿主访问时自行
  `docker run -p 127.0.0.1:8080:8080` 或临时加 `ports`，**公网机器上不要这么做**。
- 数据持久化在 Docker 卷 `tally-data`（容器内 `/app/data/tally.db`）

> **单实例限制**：当前周期账单生成与进程内限流基于单进程 SQLite；请勿横向多实例共享同一
> SQLite 文件（如需多实例，先将数据库迁移到 PostgreSQL/MySQL 等共享存储，或加分布式锁）。

## 方式三：直接运行

```bash
cd backend
cp .env.example .env        # 编辑 JWT_SECRET 等配置
pnpm install
pnpm build
node dist/index.js
```

## 方式四：pm2 常驻

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
| `BASE_CURRENCY` | CNY | 基准币种，统计/总资产的统一换算口径。**非 CNY 时必须同时提供该基准的汇率数据**：内置兜底汇率表是人民币视角，缺少对应数据时会静默按 CNY 汇率换算（实测偏差可达数倍），启动日志会打印告警 |
| `EXCHANGE_RATE_FETCH_ENABLED` | false | 汇率自动拉取开关。设为 `1` 后启动 30 秒拉一次、每日 04:30 定时刷新**全局兜底汇率**（用户手工设置的汇率仍优先）；失败只记日志、绝不删除已有汇率 |
| `EXCHANGE_RATE_FETCH_URL` | open.er-api.com 免费接口 | 汇率源地址（返回 `{ result, base_code, rates }` 的 JSON 接口；自部署可换内网镜像/代理）。源基准与 `BASE_CURRENCY` 不一致时，抓取会自动交叉换算到基准后入库（`rate(基准→X) = rates[X] / rates[基准]`）；若响应里没有基准币的汇率则明确报错并保留旧值，绝不按对方基准写错 |
| `CORS_ORIGINS` | （空） | CORS 白名单，逗号分隔。开发为空放行所有；**生产为空则不放行任意 Origin**，生产务必显式列出前端域名 |
| `TRUST_PROXY` | 0 | 可信反向代理层数；部署在反代后才设置，用于从 `X-Forwarded-For` 还原客户端 IP 做限流。默认不信任客户端伪造的 XFF |
| `LOG_LEVEL` | warn | Fastify(pino) 日志级别；生产建议 `info`，`off` 关闭 |
| `DISABLE_RATE_LIMIT` | false | 关闭认证限流（不建议生产） |
| `AUTH_RATE_MAX`（预留） | 60/分钟 | 短信验证码相关接口限流阈值（IP + 账号双维度；当前默认 60） |
| `ACCESS_TOKEN_TTL` | 15m | 访问令牌有效期（如 `15m`、`1h`） |
| `REFRESH_TOKEN_TTL` | 30d | 刷新令牌有效期（如 `30d`、`90d`） |
| `ALIYUN_SMS_ENABLED` | false | 开启阿里云短信验证码；未开启时验证码直接返回（开发模式） |
| `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` | - | 阿里云 AccessKey（也可用 `ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET`） |
| `ALIYUN_SMS_SIGN_NAME` / `ALIYUN_SMS_TEMPLATE_CODE` | - | 短信签名与模板 code（模板参数用 `{"code","min"}`） |

> **生产必须配置短信**：手机号 + 短信验证码是本项目唯一登录/认证通道（无密码、无密码重置、无邮箱认证）。
> 未配置时生产登录接口返回 `503 SMS_SEND_FAILED` —— 刻意不返回「成功但拿不到验证码」。
> 新账号登录后会强制设置**全局唯一公开昵称**；旧邮箱/密码路由已下线（后端返回 410），见 [docs/api.md](api.md)。

## 数据备份

直接备份 SQLite 文件即可（连同 `-wal`/`-shm`，或备份前先停服）：

```bash
sqlite3 data/tally.db ".backup 'backup.db'"
```

> ⚠️ **校验**备份时注意 CLI 版本：老发行版自带 `sqlite3` 3.26（2018）读不了新版 schema，
> `PRAGMA integrity_check` 会报 `malformed database schema (guard_0021_nickname_dup)` —— 那是 CLI
> 太旧，不是备份坏了（真机实测）。`.backup` 本身是页级拷贝不受影响；校验请改用应用同款引擎：
> `node -e "const D=require('better-sqlite3');console.log(new D('<备份文件>',{readonly:true}).pragma('integrity_check'))"`。

建议用仓库内的 `scripts/backup.sh` 并配合 cron 每日备份（保留策略见 `scripts/prune-retention.mjs`：
近 7 天每天一份、8–30 天每周一份、31–180 天每月一份、180 天后删除）：

```bash
15 3 * * * /path/to/Tally/scripts/backup.sh /path/to/data/tally.db /path/to/backups >> /var/log/tally-backup.log 2>&1
```

> **本机留一份不叫备份**：必须再同步一份到异机/对象存储，并且**每月做一次真实恢复演练**
> （`scripts/restore.sh` + `PRAGMA integrity_check` + 抽样核对）。执行任何迁移之前先做一次
> 完整备份。细则与记录表见 [docs/production-checklist.md](production-checklist.md) 第 7/8 节。

## 上线 HTTPS（重要）

> 完整的生产发布核对（域名/TLS/JWT/CORS/TRUST_PROXY、迁移前备份、异机备份与恢复演练、
> 健康检查/日志/告警、iOS 发布资产）见 **[docs/production-checklist.md](production-checklist.md)**。

App 端 ATS 已收紧（不再使用全局 `NSAllowsArbitraryLoads`，仅保留 `NSAllowsLocalNetworking` 供本地/局域网 HTTP 联调），且 API 地址由**构建配置注入**：

- `ios/project.yml` 的 `configs.Debug.TALLY_API_BASE_URL` 为 `http://localhost:8080`；
  **`configs.Release` 故意留空**（历史上的 `https://your-production-domain.example.com` 占位值已删除）。
- Release 构建带一个 pre-build Run Script，调用 `ios/scripts/validate-api-url.sh`：
  地址为空/未展开、非 HTTPS、`localhost`/`127.x`/私网 IP/裸 IP、单标签主机名、
  `example.com`/`.test`/`.invalid`、`your-*`/`placeholder` 等占位词 → **构建立即失败**。
- CI 会显式注入正式生产域名：`xcodebuild ... TALLY_API_BASE_URL=<PROD_API_BASE_URL>`，
  该值只存在于**仓库变量** `PROD_API_BASE_URL`（Settings → Secrets and variables → Actions → Variables），
  代码与文档里都不落真实域名；**未设置该变量时 Release 构建会直接失败**（刻意如此，见
  `docs/secret-hygiene.md`），`workflow_dispatch` 可用输入 `api_base_url` 覆盖。构建后用
  `validate-api-url.sh --plist Tally.app` 复核**产物 Info.plist**。
- `Info.plist` 的 `TallyAPIBaseURL` 引用 `$(TALLY_API_BASE_URL)`，由 Xcode 构建时替换；`APIClient` 读取该键，
  Release 下再兜一层（非 HTTPS 或本机/示例/占位域名直接 `fatalError`）。

生产环境请：

1. 用 Nginx/Caddy 反向代理并启用 TLS（如 Let's Encrypt），并设置后端 `TRUST_PROXY=1`。
   若已有 Caddy 在服务别的站点，**不要**另起一套：给现有 Caddyfile 追加 site block 即可
   （见 [production-deploy.md](production-deploy.md) 第 6 节），否则 80/443 会冲突。
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

- xlsx（Excel）解析运行在 **worker 线程** 中（`backend/src/lib/xlsxWorker.cjs`，TS 声明见同目录 `.cts`），并施加资源限制：
  - 内存：worker 堆上限（旧代 64MB / 新生代 16MB）。
  - 超时：单次解析 20s 超时，超时强制 `terminate()` 并返回明确错误；若 worker 在任何结果返回前就退出，Promise 也会被 reject（不会留下永不完成的调用）。
  - 输入：文件大小 ≤5MB（上传层另有 20MB 总量限制）。
  - 输出：返回行数 ≤100,000、列数 ≤256、返回单元格总数 ≤500,000。
  - 并发：同一进程内同时最多运行 4 个解析 worker（超出排队等待），防止并发上传瞬时打满 CPU/内存。
- **重要：worker 线程不是进程级硬隔离。** 它与主进程共享同一个地址空间与文件描述符表，仅提供独立的 V8 堆 / 事件循环 / 崩溃边界；恶意代码仍可能在理论上影响同一进程的其他线程（共享进程级状态、文件描述符等）。真正“进程级硬隔离”需要 `child_process`（独立进程），本方案未采用。
- **残余风险**：worker 内的 zip 解压仍会先整份放入内存，若遇到“超高压缩比+超大”的构造文件，可能在 64MB 堆内触发 OOM（仅终止该 worker，通常不影响主进程）。如需更强隔离，可进一步先在子进程解压/限流，或对解压后流式分块校验；当前 5MB 输入上限 + 并发/行/单元格上限 + worker 内存/超时已把影响范围收窄。
