# Tally 生产上线清单（Production Readiness Checklist）

> 适用范围：`backend/`（Node + SQLite，单实例）+ Caddy HTTPS + iOS 客户端（`ios/` 联网版、
> `ios-local/` 离线版）。**按顺序执行**，每一节都有可复制的命令与「完成判据」。
> 任何一项不通过，不得发布。

发布前一次性确认（本文所有 `<...>` 都要替换成真实值，禁止 example.com / your-* 等占位）：

| 项 | 值 | 说明 |
|---|---|---|
| 生产 API 域名 | `https://your-domain.cn` | 正式生产唯一域名；本仓库文档 / CI（`PROD_API_BASE_URL`）/ iOS Release 均使用它 |
| 预发/staging API 域名 | 无（不保留 staging） | CI 的 Release 构建 / 主干 Archive / 产物校验统一注入 `https://your-domain.cn` |
| 部署方式 | `docker compose -f docker-compose.caddy.yml` | Caddy 仅暴露 80/443，后端 8080 只在 Docker 内网 |
| 单实例约束 | 1 个后端进程 | 周期账单调度与限流都是进程内的；SQLite 不可多实例共享。多实例前必须先换 PG/MySQL |

---

## 1. 域名 / DNS

- [ ] 生产域名 `your-domain.cn` 的 **A 记录**指向服务器公网 IP（有 IPv6 再加 AAAA）。
- [ ] `dig +short your-domain.cn` 返回预期 IP；TTL 在切流窗口内先调低（如 300s）。
- [ ] 云厂商解析里没有遗留指向旧机器/已释放 IP 的记录。
- [ ] **判据**：`dig +short your-domain.cn` 与 `curl -sS https://your-domain.cn/health/live` 都指向新实例。
- [ ] 不要用裸 IP 作为 App 的 API 地址：Let's Encrypt 不给纯 IP 签证书，且
      `ios/scripts/validate-api-url.sh` 会直接拒绝 IP/单标签主机名。

## 2. TLS / HTTPS（Caddy）

- [ ] 只用仓库里的生产栈：`backend/docker-compose.caddy.yml` + `backend/Caddyfile`
      （站点地址由 `TALLY_DOMAIN` 注入，不设默认值 —— 忘填就起不来，避免占位域名上线）。
- [ ] 设置有效的 `ACME_EMAIL`（无默认值），用于证书异常通知并启用 Caddy 的
      Let's Encrypt → ZeroSSL 双 CA 自动回退。
- [ ] 安全组/防火墙**只放行 22/80/443**；`443/udp`（HTTP/3）按需，不需要就别开。
- [ ] 后端 8080 不对宿主/公网发布（compose 里后端只有 `expose`，没有 `ports`）。
- [ ] 证书：Caddy 自动签发 + 自动续期；确认 80 端口可达（ACME http-01）。
- [ ] HSTS 已在 `Caddyfile` 里下发（`max-age=31536000; includeSubDomains`）。
      ⚠️ 一旦下发 HSTS，降级回 HTTP 会让客户端直接失败，回滚只能换域名。
- [ ] **判据**：
      ```bash
      cd backend
      docker compose -f docker-compose.caddy.yml config --quiet         # 配置可渲染
      docker compose -f docker-compose.caddy.yml ps                     # 两个服务 healthy
      curl -sSI https://your-domain.cn/health/live | head -1           # 200
      curl -sS  https://your-domain.cn/health/ready                    # migrationsApplied > 0
      echo | openssl s_client -connect your-domain.cn:443 -servername your-domain.cn 2>/dev/null \
        | openssl x509 -noout -dates -issuer                            # 证书未过期、签发者为受信任公网 CA
      ```
- [ ] 证书到期前 30 天内有告警（见第 9 节）。

## 3. JWT 密钥

- [ ] 生产 `JWT_SECRET` = `openssl rand -hex 32`（≥32 位随机、非占位）。
      生产模式启动时会校验：占位/过短密钥**直接拒绝启动**（`backend/src/config.ts`）。
- [ ] 密钥只存在服务器的 `/etc/tally/env`（或密钥管理服务）里，**不进 Git**、不进镜像层。
      `backend/.env` 已在 `.gitignore` 内。
- [ ] 访问令牌 15m / 刷新令牌 30d（`ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL`）按需收紧；
      刷新令牌落库为 SHA-256 哈希；旧会话通过刷新链路轮换（无密码体系，无需“重置密码吊销”）。
- [ ] 轮换流程（密钥泄漏或例行轮换）：
      1. 公告 → 2. 新密钥写入环境变量 → 3. 重启后端（全部 JWT 立即失效，用户需重新登录）
      → 4. 观察 401 峰值与登录成功率。轮换必须与备份（第 5 节）分开做，别叠加风险。
- [ ] **判据**：`docker compose exec tally-backend printenv JWT_SECRET | wc -c` ≥ 65，且不等于 `.env.example` 里的开发占位值。

## 4. CORS

- [ ] 有 Web 端就必须显式写 `CORS_ORIGINS`（逗号分隔、含协议、无尾斜杠）。
- [ ] 生产未配置 `CORS_ORIGINS` 时后端**不放行任何带 Origin 的跨站请求**（只允许无 Origin 的同源/原生客户端），
      iOS 客户端不受影响；这是刻意的默认收紧，不要为了省事写成 `*`。
- [ ] **判据**：
      ```bash
      curl -sS -H 'Origin: https://evil.tld' -o /dev/null -D - https://your-domain.cn/health \
        | grep -i 'access-control-allow-origin' || echo "未放行任意源（符合预期）"
      ```

## 5. 反向代理与 TRUST_PROXY

- [ ] 后端位于 Caddy 之后 ⇒ 设 `TRUST_PROXY=1`（compose 默认已为 1）。
      否则限流会把所有用户算成同一台代理 IP（要么集体 429，要么形同虚设）。
- [ ] 只有 1 层代理就填 1；再套一层 CDN 才填 2。**不要**盲目调大：
      取值是「X-Forwarded-For 从右往左第 N 个」，N 大于真实层数会把客户端伪造的左侧地址当真实 IP。
- [ ] **判据**：连续 60+ 次错误登录只应封禁该客户端；换一个客户端登录不受影响。
      回归测试：`cd backend && pnpm test`（`test/trustProxy.test.ts`、`test/rateLimitTrust.test.ts`）。
- [ ] Caddy 已透传 `X-Forwarded-For`（`reverse_proxy` 默认行为，无需额外配置）。

## 6. 无密码认证与短信验证码（唯一通道；无重置、无邮箱）

- [ ] 明确记录：**本项目无密码、无密码重置、无邮箱认证**。没有 `password_hash`，没有 SMTP，
      没有邮件 reset-token。身份 = 手机号（E.164）+ 全局唯一公开昵称。
- [ ] 旧 `POST /auth/register`、`/auth/login`、`/auth/reset-code`、`/auth/reset-password` 已下线，
      后端保留路由但统一返回 `410 AUTH_METHOD_REMOVED`，不要再调用它们。
- [ ] 生产必须配好阿里云短信，否则登录接口（`/auth/login-code` 路径）会返回 `503 SMS_SEND_FAILED`
      （这是刻意行为：绝不「返回成功但用户拿不到验证码」）：
      `ALIYUN_SMS_ENABLED=true`、`ALIYUN_ACCESS_KEY_ID/SECRET`、`ALIYUN_SMS_SIGN_NAME`、`ALIYUN_SMS_TEMPLATE_CODE`。
- [ ] **认证模式必须为 `production`**（生产编排已显式钉住，勿改动）。`AUTH_MODE=development` 会把短信验证码
      **明文回传给请求方**，任何人只要知道手机号即可调用 `/auth/login-code` 登录该账号（含已注册老用户）。

      `NODE_ENV` / `AUTH_MODE` 组合的启动行为（由 `backend/src/config.ts` 的互锁与
      `test/prodSecurity.test.ts` 的回归用例共同保证）：

      | `NODE_ENV` | `AUTH_MODE` | 启动 | 验证码回传 |
      |---|---|---|---|
      | `production` | 未设置（默认 production） | ✅ 正常 | ❌ 永不回传 |
      | `production` | `production` / `PRODUCTION`（大小写与首尾空白会归一） | ✅ 正常 | ❌ 永不回传 |
      | `production` | `development` | ⛔ 拒绝启动 | — |
      | `production` | 拼错/非法值（如 `develpoment`、`prod`、`1`） | ⛔ 拒绝启动 | — |
      | `production` | 任意值 + `DISABLE_RATE_LIMIT=true` | ⛔ 拒绝启动 | — |
      | 未设置 | 未设置（默认 development） | ✅ 正常（本地开发/测试） | ⚠️ **会回传**（有意行为，仅供本机联调） |

      **注意**：裸跑 `node dist/index.js`、systemd 单元等未设 `NODE_ENV` 的场景会落入最后一行，
      即"能回传验证码的开发模式"。对外部署必须显式 `NODE_ENV=production`（compose 与镜像内均已设）。
      若开发模式下同时配置了真实短信凭据，启动日志会打印醒目告警。
- [ ] 用真机跑一遍完整闭环：`/auth/request-code` 收到短信 → `/auth/login-code` 登录 →
      新账号走 `/auth/complete-profile` 强制设置唯一昵称 → 家庭/账本可用。
- [ ] 运维侧预案：短信不可用时的**人工运维 SOP**（核实用户身份 → 核对/修正 `users.phone` 或
      `users.nickname_key` → 视需要删除该用户 `auth_sessions` 让其重新登录）；操作前必须先做第 7 节的迁移前备份。
- [ ] **判据**：`cd backend && pnpm test`（`test/prodSecurity.test.ts` 断言生产模式不会假成功、
      `AUTH_MODE`/`DISABLE_RATE_LIMIT` 非法组合拒绝启动，
      `test/api.test.ts` + `completeProfileAtomic.test.ts` 覆盖短信登录与强制昵称闭环）；
      编排层由 `scripts/check-compose-auth-mode.mjs` 守门（CI 已接入）。

## 6.5 数据审计：币种与负债口径（本次修复后的上线前检查）

- [ ] **币种合法性审计**：历史版本允许写入任意币种字符串（如 `hello`），统计侧对未知币种按 1:1 兜底
      会静默算错金额。升级后写接口已强校验，存量数据请用下面的 SQL 确认一次：
      ```bash
      sqlite3 /app/data/tally.db "
        SELECT 'accounts' t, currency, COUNT(*) FROM accounts GROUP BY currency
        UNION ALL SELECT 'transactions', currency, COUNT(*) FROM transactions GROUP BY currency
        UNION ALL SELECT 'loans', currency, COUNT(*) FROM loans GROUP BY currency;"
      ```
      期望：所有 `currency` 都是 3 位大写字母（`CNY`/`USD`…）。小写值（如 `usd`）已被读侧自动归一；
      非 3 字母的脏值需要人工确认后修正（例如按实际来源改为 `CNY`）。
- [ ] **负债口径一致性**：同一账本下 `/stats/summary.totalDebt` 与 `/liabilities.totalDebt` 必须相等
      （外币信用卡欠款与外币贷款都要按汇率折算后再相加）。
      ```bash
      curl -sS -H "Authorization: Bearer $TOKEN" https://<域名>/api/v1/liabilities | jq .totalDebt
      curl -sS -H "Authorization: Bearer $TOKEN" "https://<域名>/api/v1/stats/summary" | jq .totalDebt
      ```
- [ ] **账户改币种限制**：升级后，已被流水/贷款/信用卡账单引用的账户改币种会返回
      400 `ACCOUNT_CURRENCY_LOCKED`。若业务上确需改，请"新建同币种账户 → 迁移流水 → 归档旧账户"。
- [ ] **短信频控参数**（可用环境变量调，生产建议保留默认）：
      `SMS_SEND_COOLDOWN_SECONDS`（默认 60）、`SMS_SEND_DAILY_LIMIT`（默认 5/号码/天）、
      `SMS_SEND_GLOBAL_DAILY_BUDGET`（默认 2000/天）；另建议在阿里云控制台再设一层号码级频控。

## 7. 迁移前备份（**执行任何 migration 之前**）

- [ ] 迁移由 `src/index.ts` 启动时自动执行（`runMigrations`）—— 所以**先停服 + 先备份**，
      再启动新版本；不要边接流量边迁移。
- [ ] 步骤：
      ```bash
      cd backend
      # 1) 停容器（避免 WAL 与主库不一致）
      docker compose -f docker-compose.caddy.yml stop tally-backend
      # 2) 在线备份（一致性快照，含 WAL）
      ../scripts/backup.sh "$(docker volume inspect tally-backend_tally-data -f '{{.Mountpoint}}')/tally.db" /srv/tally-backups/pre-migration
      # 3) 记录指纹与迁移水位，便于事后核对/回滚
      sha256sum /srv/tally-backups/pre-migration/tally-*.db | tail -1
      sqlite3 <备份文件> "PRAGMA integrity_check; SELECT COUNT(*) FROM schema_migrations;"
      ```
- [ ] 迁移脚本评审：只允许**追加**新编号迁移（当前最新已到 `backend/migrations/0023_*.sql`，共 23 个）；
      已上线的迁移文件与数据库里已应用的记录一律不许改（`test/migration.test.ts` 会校验）。
- [ ] 回滚预案：SQLite 无 down migration —— 回滚 = 停服 → `scripts/restore.sh <迁移前备份> backend/data` →
      起旧镜像 tag。演练过一次才算有预案（见第 8 节）。
- [ ] 完成判据：迁移后 `GET /health/ready` 的 `migrationsApplied` 等于迁移文件数，
      `PRAGMA integrity_check` 返回 `ok`，关键页面无 500。

## 8. 异机备份与恢复演练

- [ ] 每日备份 cron（保留策略：近 7 天每天 / 8–30 天每周 / 31–180 天每月 / 180 天后删除）：
      ```cron
      15 3 * * * /opt/tally/scripts/backup.sh /srv/tally/data/tally.db /srv/tally-backups/daily >> /var/log/tally-backup.log 2>&1
      ```
- [ ] **异机副本**（本机留一份不算备份）：备份目录再同步到另一台机器/对象存储，并只追加、加密：
      ```bash
      # 方式 A：rsync 到异机（-e ssh，仅追加，避免覆盖）
      rsync -aPH --append-verify --delete-excluded --include='tally-*.db' --exclude='*' \
        /srv/tally-backups/ backup@offsite.example-host:/srv/tally-offsite/
      # 方式 B：rclone 到对象存储（建议开服务端加密 + 生命周期 180 天）
      rclone copy /srv/tally-backups/daily remote:tally-backup/daily --immutable
      ```
      （目标主机名/桶名必须换成真实值，本仓库文档里的名字只是占位示例）
- [ ] 副本完整性校验：把 sha256 清单一起同步；异机侧 `sha256sum -c` 必须全通过。
- [ ] **恢复演练（每月一次，必须留记录）**：
      ```bash
      scripts/restore.sh /srv/tally-offsite/tally-<时间戳>.db /tmp/tally-restore-drill
      sqlite3 /tmp/tally-restore-drill/tally.db "PRAGMA integrity_check; SELECT COUNT(*) FROM transactions;"
      # 用恢复出的库拉起一个隔离实例，验证能登录/能查流水（不接生产流量）
      DATABASE_URL=/tmp/tally-restore-drill/tally.db PORT=18099 node dist/index.js &
      curl -sS localhost:18099/health/ready
      ```
- [ ] 演练记录表（写进运维日历/工单）：日期、备份文件、sha256、恢复耗时、`integrity_check` 结果、
      抽样核对（用户数/流水数/总金额）、执行人、结论。
- [ ] 自动化回归：`cd backend && pnpm test`（`test/backup.test.ts` 覆盖备份可恢复、`test/retention.test.ts` 覆盖保留策略）。
- [ ] 磁盘水位：备份目录有上限与告警（`prune-retention.mjs` 只删旧备份，不会替你删别的）。

## 9. 健康检查

| 探针 | 用途 | 语义 |
|---|---|---|
| `GET /health` | 人工快速确认 | 进程 + `SELECT 1` |
| `GET /health/live` | k8s/compose liveness | 只看进程活着，不依赖 DB |
| `GET /health/ready` | readiness / 拨测 | DB 可达 **且** `schema_migrations` 有记录，返回 `migrationsApplied` |

- [ ] compose 里两个服务都有 `healthcheck`（后端用 Node fetch 打 `/health/live`；Caddy 镜像无 bash，
      用镜像自带的 busybox `nc -z` 探活 80/443），`restart: unless-stopped`，
      `caddy` 通过 `depends_on: condition: service_healthy` 等后端就绪。
- [ ] 外部拨测（独立于本机，能区分「服务器挂」与「网络挂」）：每 60s 打一次
      `https://your-domain.cn/health/ready`，连续 3 次失败告警。
- [ ] 反代层加探活：Caddy 挂了也要能发现（`docker compose ps` / `systemctl` 级监控）。

## 10. 日志

- [ ] 后端：`LOG_LEVEL=info`（Fastify pino JSON）；**验证码 / reset token / JWT / 密码永不落日志**
      （`src/lib/sms.ts` 只打印发送结果，不回显内容）。
- [ ] 访问日志：Caddy JSON 落 `/data/access.log`（命名卷持久化，10MB × 5 滚动，最多 30 天）。
- [ ] 容器日志轮转：compose 已配 `json-file max-size=10m max-file=5`，防日志撑爆磁盘。
- [ ] 链路追踪：每个响应带 `x-request-id`，报障时以它为线索串后端日志。
- [ ] 关键操作有审计：`audit_logs` 表（迁移 `0011_audit_logs.sql`），排障先查它。
- [ ] 采集：`docker logs` / journald → 集中收集（Loki/Vector/CloudWatch 任一）；保留 ≥ 30 天。
- [ ] 命令速查：
      ```bash
      docker compose -f docker-compose.caddy.yml logs --since 30m --tail 200 tally-backend
      docker compose -f docker-compose.caddy.yml exec caddy tail -n 100 /data/access.log
      ```

## 11. 告警

至少覆盖以下 7 条，每条都要有「谁负责、什么渠道、多久响应」：

| # | 触发条件 | 级别 | 建议实现 |
|---|---|---|---|
| 1 | `/health/ready` 连续 3 次失败或 > 2s | P1 | 外部拨测（Uptime Kuma / Blackbox Exporter） |
| 2 | 容器 `unhealthy` 或非 `Up` | P1 | `docker compose ps` 巡检脚本 / cAdvisor |
| 3 | 备份文件 26h 内没有新增，或 `sha256sum -c` 失败 | P1 | cron 任务退出码 + 心跳（healthchecks.io 类） |
| 4 | TLS 证书剩余有效期 < 21 天 / 续期日志报错 | P2 | `openssl s_client` 定时探测 |
| 5 | 磁盘使用 > 80%（尤其 SQLite 与备份目录） | P2 | `df` 巡检；SQLite 增长快时提前扩盘 |
| 6 | 5xx 比例 > 1%（5 分钟窗口）或登录成功率骤降 | P2 | 反代指标 + 简单阈值 |
| 7 | 备份恢复演练超期（> 35 天未做） | P3 | 日历/工单提醒 |

- [ ] 告警渠道打通（短信/IM webhook），并且**做过一次人为触发验证**。
- [ ] Runbook：P1 的第一动作是「确认备份可用 + 判定回滚还是前滚」，不是急着改代码。

## 12. iOS 发布资产与 Release 构建

- [ ] 联网版（`ios/`）与离线版（`ios-local/`）都通过资产检查：
      ```bash
      ./scripts/check-ios-release-assets.sh ios Tally
      ./scripts/check-ios-release-assets.sh ios-local Tally
      ```
      （检查 1024×1024 无 alpha 的 AppIcon、`ASSETCATALOG_COMPILER_APPICON_NAME`、
      `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` 各配置一致、Bundle ID、签名身份、最低系统版本）
- [ ] Release 版本号与构建号已在两个工程里提升（当前约定 `1.0.0 (1)`）；提交 `.pbxproj` 变更。
- [ ] Release 构建必须显式注入真实 HTTPS 地址；**没有有效地址时构建直接失败**：
      ```bash
      xcodebuild -project ios/Tally.xcodeproj -scheme Tally -configuration Release \
        -destination 'generic/platform=iOS' -allowProvisioningUpdates \
        TALLY_API_BASE_URL=https://your-domain.cn ...
      # 产物复核（禁止 localhost / 示例域 / 占位 / http）
      ios/scripts/validate-api-url.sh --plist "<...>/Release-iphoneos/Tally.app"
      ```
- [ ] 产物 Info.plist 的 `TallyAPIBaseURL` 是真实域名；二进制里不含 `example.com`/`http://localhost`。
- [ ] Archive 完成且可安装/TestFlight 上传（签名身份与 `DEVELOPMENT_TEAM` 有效）。
- [ ] Git 索引里没有 `xcuserdata`（构建后 `git status --porcelain` 为空）。

## 13. 发布流程（一次性执行顺序）

1. 冻结变更 → `git status --porcelain` 为空，CI 全绿。
2. 第 7 节「迁移前备份」+ 校验和。
3. `docker compose -f docker-compose.caddy.yml build` → 记录镜像 tag/digest。
4. `docker compose -f docker-compose.caddy.yml up -d`（新版本容器自动跑迁移）。
5. 健康检查：`/health/ready` 的 `migrationsApplied` 与迁移文件数一致。
6. 冒烟：注册/验证码恢复/记账/预算/统计/家庭/负债/导入各跑一遍真实链路。
7. 观察 15 分钟日志与 5xx；确认无异常后关闭变更窗口。
8. 回滚：`docker compose -f docker-compose.caddy.yml up -d --no-build`（旧 tag）+ 必要时
   `scripts/restore.sh <本次迁移前备份> backend/data`。

## 14. 发布后 24 小时观察

- [ ] 5xx、P95 延迟、401 比例（JWT/CORS 改错会立刻表现为 401/CORS 报错）。
- [ ] 磁盘、SQLite 文件大小、`-wal` 是否异常膨胀（异常膨胀常意味着长事务未提交）。
- [ ] 备份任务实际产出文件并可 `sqlite3 ... "PRAGMA integrity_check"`。
- [ ] 至少一次真实用户恢复/登录成功记录（说明短信通道正常）。
- [ ] 证书续期由 Caddy 自动完成，检查 `docker compose logs caddy | grep -i tls`。

---

## 15. 手机号 + 唯一昵称 / 单家庭迁移（0021-0022）上线步骤

> 本迁移将 `users` 身份重建为 `phone`（+86 E.164）与唯一公开 `nickname`，并新增
> `onboarding_tickets` / `nickname_history` 表；家庭模型收敛为单家庭 + 昵称邀请
> （`family_invitations.target_user_id`，无外部 token）。**部署顺序不可颠倒：先后端后 iOS。**

- [ ] 上线前确认生产库满足迁移前提：**只有大陆手机号账号、无邮箱账号**（当前生产库为
      `1` 个手机号账号、`0` 个邮箱账号），且无旧家庭/成员/邀请数据（0022 不迁移旧邀请）。
- [ ] 发布前对生产 SQLite 做一致备份并保留到观察期结束（`scripts/backup.sh` +
      `sqlite3 ... PRAGMA integrity_check`）。
- [ ] 先部署支持新协议的后端，启动后确认 `schema_migrations` 共 **22** 个迁移
      （`0001` → `0022` 全部应用），再安装新版 iOS；如迁移中途失败（含 0021 守门触发），
      SQLite 会整体回滚到 0020，可用备份直接恢复。
- [ ] 每次应用 0021 都会吊销全部旧会话：旧客户端必须重新登录；旧“用户”昵称账号
      下次通过短信验证后进入强制昵称设置页。
- [ ] 上线后依次验证：短信登录（新/旧账号）、强制昵称设置、个人账本、创建/邀请/接受/
      退出/删除家庭、账本切换；并抽查家庭响应与日志均不出现明文手机号。
- [ ] 保留备份进入观察期（≥24h），按第 14 节观察 401 比例 / 5xx / 验证码服务成功率。


---

## 附：本仓库的本地/CI 验收命令

```bash
# 环境自检（node 是否真实 Node / Xcode 许可证 / 原生依赖 / Docker）
./scripts/check-dev-env.sh
```

```bash
# 后端全量
cd backend && pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm audit --audit-level=critical --prod
pnpm build && node scripts/smoke-dist-xlsx.mjs

# 容器编排与镜像（需要 Docker 环境）
cd backend
docker compose -f docker-compose.caddy.yml config --quiet
docker build -t tally-backend:latest .

# iOS
./scripts/check-ios-build-settings.sh ios/Tally.xcodeproj Tally
xcodebuild -project ios/Tally.xcodeproj -scheme Tally -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
xcodebuild -project ios/Tally.xcodeproj -scheme Tally -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  build CODE_SIGNING_ALLOWED=NO TALLY_API_BASE_URL=https://your-domain.cn
ios/scripts/validate-api-url.sh --plist <Release Tally.app 路径>
xcodebuild -project ios-local/TallyLocal.xcodeproj -scheme Tally \
  -destination 'platform=iOS Simulator,name=iPhone 16' test

# 仓库卫生
git diff --check
git ls-files | grep -E 'xcuserdata|\.xcuserstate' && echo "不应存在" || echo OK
git status --porcelain   # 构建后应为空
```

> 各项验收在开发环境的实际执行结果与复现命令，见 [`release-acceptance.md`](./release-acceptance.md)。
