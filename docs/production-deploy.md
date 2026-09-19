# 生产部署：裸机 + systemd + 共享 Caddy

> 本文记录**当前生产环境真实使用**的部署方式（2026-09-17 后端迁移 0023 上线即按此执行）。
>
> 仓库里的 `backend/docker-compose.caddy.yml` 是**自包含方案**：Caddy 与后端都在容器内，
> 独占宿主 80/443，适合「一台只为 Tally 服务的机器」。本文这套适合「主机上已经有一个 Caddy
> 在跑别的站点」的情况。**两者的后端产物、环境变量、健康判据完全相同**，差别只在
> 「谁托管进程」与「谁做 TLS 终止」。选一种即可，不要在同一台机器上同时用。

## 0. 什么时候不要用 Docker 版

生产机是 **Alibaba Cloud Linux 3，未安装 Docker**；Caddy 是**共享**的：同一个 Caddy 进程
同时服务多个站点（`/etc/caddy/Caddyfile` 内多个 site block，各自
`reverse_proxy 127.0.0.1:<端口>`）。因此：

- ⛔ **不要**在这台机器上执行 `docker compose -f docker-compose.caddy.yml up -d`：
  compose 里的 Caddy 会抢占宿主 **80/443**，与现有 Caddy 直接冲突（其余站点全部掉线）。
- ✅ 后端作为 systemd 服务常驻，只监听 `127.0.0.1:18080`，由**已有** Caddy 反代。
- ✅ 版本切换用「发布目录 + `current` 软链」（`ln -sfn` + `mv -T`），而不是镜像 tag。

> 判断口诀：**80/443 在谁手里？** 已经有人（别的站点）在听 → 用本文；机器是 Tally 独占 → 用 compose。

## 1. 宿主机布局

| 路径 | 说明 |
|---|---|
| `/opt/tally/releases/<release-id>/` | 每次发布的**不可变副本**（`release-id` 形如 `import-YYYYMMDD-<短SHA>`） |
| `/opt/tally/current` | 指向当前生效 release 的软链（systemd 的 `WorkingDirectory`） |
| `/opt/tally/runtime/node-v24.20.0-linux-x64/` | 固定版本 Node 运行时（**不用**发行版 node） |
| `/opt/tally/runtime/pnpm-11.19.0/` | 固定版本 pnpm |
| `/opt/tally/DEPLOYMENT.md` | 服务器侧部署记录（每次发布追加一节，不随 release 覆盖） |
| `/etc/tally/tally.env` | 生产环境变量（`0600 root:root`，由 systemd `EnvironmentFile` 读取） |
| `/var/lib/tally/tally.db` | SQLite 数据库（`600 tally:tally`，父目录 `750 tally:tally`） |
| `/var/lib/tally/backups/` | 备份目录（`750 tally:tally` —— **必须对执行备份的那个用户可写**） |
| `/etc/systemd/system/tally-backend.service` | systemd 单元 |

专用系统用户（无登录 shell、无 home 可写、**不拥有** `/etc/tally/tally.env`）：

```bash
useradd --system --no-create-home --shell /sbin/nologin tally
install -d -o tally -g tally -m 0750 /var/lib/tally /var/lib/tally/backups
install -d -o tally -g tally -m 0755 /opt/tally/releases
```

> 目录权限要和「谁来跑备份」对齐。典型症状：备份目录是 `root:root 755` 时，
> `sudo -u tally sqlite3 … ".backup '/var/lib/tally/backups/x.db'"` 会报
> `unable to open database file` —— 其实**不是数据库打不开，是目标目录不可写**。

## 2. 生产环境变量（`/etc/tally/tally.env`）

```bash
NODE_ENV=production
PORT=18080
HOST=127.0.0.1
DATABASE_URL=/var/lib/tally/tally.db
JWT_SECRET=<openssl rand -hex 32 的输出>
APP_TIMEZONE=Asia/Shanghai
CORS_ORIGINS=https://<你的域名>
TRUST_PROXY=1
LOG_LEVEL=info
ALIYUN_SMS_ENABLED=true
ALIYUN_ACCESS_KEY_ID=<...>
ALIYUN_ACCESS_KEY_SECRET=<...>
ALIYUN_SMS_SIGN_NAME=<...>
ALIYUN_SMS_TEMPLATE_CODE=<...>
```

```bash
umask 077
cat > /etc/tally/tally.env <<'ENV'
...上面的内容（把 <...> 换成真实值）...
ENV
chown root:root /etc/tally/tally.env     # 最终应为 600 root:root：systemd 以 root 读，进程以 tally 跑
```

要点（详见 [production-checklist.md](production-checklist.md)）：

- **`NODE_ENV=production` 必须显式写**。裸跑 / systemd 忘记设置会落入"能回传验证码的开发模式"；
  生产环境还额外有互锁：`AUTH_MODE=development`、非法 `AUTH_MODE`、或
  `DISABLE_RATE_LIMIT=true` 都会让进程**拒绝启动**（`backend/src/config.ts`）。
- `HOST=127.0.0.1`：只监听回环，公网必须经 Caddy，禁止把 18080 暴露到公网（安全组只留 22/80/443）。
- `TRUST_PROXY=1`：后端在 1 层反代之后，限流才能还原真实客户端 IP；再套 CDN 才改 2。
- 该文件**不进 Git**，也不要放进 release 目录（避免随发布副本泄漏 + 便于 `0600` 权限隔离）。

## 3. systemd 单元

`/etc/systemd/system/tally-backend.service`：

```ini
[Unit]
Description=Tally API (production)
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
User=tally
Group=tally
WorkingDirectory=/opt/tally/current
EnvironmentFile=/etc/tally/tally.env
ExecStartPre=/usr/bin/test -s /var/lib/tally/tally.db
ExecStart=/opt/tally/runtime/node-v24.20.0-linux-x64/bin/node dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/tally
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LimitNOFILE=65536
MemoryMax=1G
SyslogIdentifier=tally-backend

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now tally-backend
systemctl status tally-backend --no-pager
```

沙箱要点：`ProtectSystem=strict` + `ReadWritePaths=/var/lib/tally` ⇒ **只有数据库目录可写**
（release 目录、`/etc`、`/tmp` 都不可写，`PrivateTmp` 给独立 `/tmp`）；
`UMask=0077` ⇒ 新建的 `-wal`/`-shm`/备份文件默认不对他人可读。
后端收到 `SIGTERM` 会优雅关闭（`TimeoutStopSec=30` 足够等待在途请求）。

## 4. 发布流程（每次都要按顺序）

### 4.1 本地：确认干净 + 全绿

```bash
git status --porcelain            # 必须为空
cd backend && pnpm typecheck && pnpm test && pnpm build
```

### 4.2 上传到新 release 目录（原子、不覆盖旧版本）

macOS 上 `tar` 会把扩展属性写成 `._*` 的 AppleDouble 文件（上传后服务器多出上百个垃圾文件），
**必须** `COPYFILE_DISABLE=1`：

```bash
SHA=$(git rev-parse --short HEAD)
REL="import-$(date +%Y%m%d)-$SHA"
COPYFILE_DISABLE=1 tar czf /tmp/$REL.tgz \
  --exclude node_modules --exclude .git --exclude data \
  backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml \
  backend/dist backend/migrations backend/scripts

scp /tmp/$REL.tgz root@<主机>:/tmp/
ssh root@<主机> "set -e
  install -d -o tally -g tally /opt/tally/releases/$REL
  tar xzf /tmp/$REL.tgz -C /opt/tally/releases/$REL --strip-components=1
  rm -f /tmp/$REL.tgz
  chown -R tally:tally /opt/tally/releases/$REL"
```

发布目录根即「后端包根」，期望内容：`dist  migrations  node_modules  package.json
pnpm-lock.yaml  pnpm-workspace.yaml  scripts`（`current` 软链直接指向它，systemd 在这里执行
`node dist/index.js`）。其中 `scripts/smoke-dist-xlsx.mjs` 供下一步自检使用。

> 该机器**没有 rsync**，用 `tar`/`scp`。`dist/` 是本地 `pnpm build` 的产物（服务器不装
> devDependencies，因此不上传 `src/` 也不在服务器编译）。

### 4.3 服务器：装生产依赖并自检

```bash
ssh root@<主机> "set -e
  cd /opt/tally/releases/$REL
  /opt/tally/runtime/pnpm-11.19.0/bin/pnpm install --prod --frozen-lockfile
  # 原生模块必须能装载（better-sqlite3 有预编译产物，装错会在这里炸）
  /opt/tally/runtime/node-v24.20.0-linux-x64/bin/node -e \"require('better-sqlite3');console.log('better-sqlite3 ok')\"
  # 产物冒烟（xlsx 解析）
  /opt/tally/runtime/node-v24.20.0-linux-x64/bin/node scripts/smoke-dist-xlsx.mjs
  chown -R tally:tally /opt/tally/releases/$REL"
```

### 4.4 迁移前备份（**跑迁移之前必须做**）

迁移在进程启动时自动执行（`runMigrations`），所以顺序是：备份 → 切软链 → 重启。

```bash
ssh root@<主机> bash -s <<'REMOTE'
set -e
# 目录权限先对齐（幂等；若备份固定以 root 跑，则把下面这行换成 -o root -g root -m 0750）
install -d -o tally -g tally -m 0750 /var/lib/tally/backups
STAMP=$(date +%Y%m%d-%H%M%S)
sudo -u tally sqlite3 /var/lib/tally/tally.db \
  ".backup '/var/lib/tally/backups/tally-pre-<迁移号>-$STAMP.db'"
ls -lt /var/lib/tally/backups/ | head -3      # 确认刚生成的备份文件（按时间倒序）
REMOTE
```

⚠️ **本机 sqlite3 CLI 是 3.26.0（2018）**，低于应用实际使用的 SQLite 3.53.2，读新版 schema 会报
`malformed database schema (guard_0021_nickname_dup) near "||"`。因此：

- `.backup` 是页级拷贝，**不受影响**，仍可用 CLI；
- 但 `PRAGMA integrity_check` / `SELECT ... FROM schema_migrations` 这类**需要解析 schema** 的操作，
  请改用应用同款引擎（见 4.6）。备份本身用 CLI，校验用 Node。

### 4.5 原子切换 + 重启

```bash
ssh root@<主机> "set -e
  ln -sfn /opt/tally/releases/$REL /opt/tally/current.new
  mv -T /opt/tally/current.new /opt/tally/current     # 原子替换，不存在中间态
  readlink -f /opt/tally/current
  systemctl restart tally-backend
  sleep 3; systemctl is-active tally-backend"
```

### 4.6 验收（本机 + 公网两层）

```bash
# 本机
ssh root@<主机> "curl -sS 127.0.0.1:18080/health/ready; echo
  journalctl -u tally-backend --since '3 minutes ago' -p warning --no-pager | tail -20"
# 公网（分离「服务挂」与「网络/证书挂」）
curl -sSI https://<你的域名>/health/live  | head -1              # 200
curl -sS  https://<你的域名>/health/ready                        # migrationsApplied 等于迁移文件数
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://<你的域名>/api/v1/auth/logout-all   # 401
```

用应用引擎校验备份（**替代不可用的 `PRAGMA integrity_check`**）：

```bash
cd /opt/tally/current && /opt/tally/runtime/node-v24.20.0-linux-x64/bin/node -e "
const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});
console.log(db.pragma('integrity_check'));
for (const t of ['users','ledgers','transactions','auth_sessions'])
  console.log(t, db.prepare('SELECT COUNT(*) c FROM '+t).get().c);
" /var/lib/tally/backups/<备份文件>.db
```

### 4.7 记录

往服务器 `/opt/tally/DEPLOYMENT.md` 追加一节：commit、迁移号、备份路径、验收结果、回滚命令。
（该文件在 release 目录**之外**，不会被发布覆盖。）

## 5. 回滚

```bash
ssh root@<主机> "set -e
  ln -sfn /opt/tally/releases/<上一个 release> /opt/tally/current.new
  mv -T /opt/tally/current.new /opt/tally/current
  systemctl restart tally-backend"
```

- release 目录**不要急着删**，至少保留上一个版本（本机保留 3–4 个）。
- 回滚代码**不等于**回滚数据库：SQLite 没有 down migration。只有当新迁移是纯增量
  （加表/加列/加索引，旧代码仍能跑）时才能只切软链；否则要
  `scripts/restore.sh <迁移前备份> …` 恢复数据库（见 [production-checklist.md](production-checklist.md) 第 7 节）。
- 回滚前先确认备份可恢复（4.6 的 Node 校验），别拿一个没验过的备份当退路。

## 6. 接入共享 Caddy（新增站点时）

在**现有** `/etc/caddy/Caddyfile` 里追加一个 site block，然后 `caddy validate` + reload：

```caddyfile
<你的域名> {
	tls {
		# 在该 Caddy 还挂着 catch-all 证书时，用 host-specific TLS 策略确保
		# 本站点拿到自己的证书，而不是被别的站点证书"盖住"。
		protocols tls1.2 tls1.3
		issuer acme {
			dir https://acme-v02.api.letsencrypt.org/directory
			email <证书联系邮箱>
		}
		issuer acme {
			dir https://acme.zerossl.com/v2/DV90
			email <证书联系邮箱>
		}
	}
	reverse_proxy 127.0.0.1:18080
	encode gzip zstd
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
	}
	log {
		output file /var/log/caddy/tally-access.log {
			roll_size 10mb
			roll_keep 5
			roll_keep_for 720h
		}
	}
}
```

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)   # 改共享配置前先备份
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy        # reload 不中断其他站点（证书在后台签发）
```

#### 运维注意

- `reload` 而不是 `restart`：restart 会让**所有**站点短暂中断。
- 首次签发需要 80 端口可达（ACME http-01）；A 记录要先指对，否则会反复失败并触发
  Let's Encrypt 速率限制。
- OCR/HTTPS 相关排查：`journalctl -u caddy --since '10 minutes ago'`；访问日志见上表的 `log` 块。
- 上线后确认 `curl -sS https://<你的域名>/health/ready` 的 `migrationsApplied` 与
  `backend/migrations/` 里的文件数一致。

## 7. 备份与恢复（生产必须落地的部分）

以 `tally` 身份安装（`crontab -u tally <文件>`）：

```cron
PATH=/opt/tally/runtime/node-v24.20.0-linux-x64/bin:/usr/bin:/bin
SHELL=/bin/sh
15 3 * * * /opt/tally/scripts/backup.sh /var/lib/tally/tally.db /var/lib/tally/backups/daily >> /var/log/tally-backup.log 2>&1
```

- **`PATH` 那行不能省**：`backup.sh` 备份完会调用 `prune-retention.mjs` 做保留策略，
  脚本里是 `command -v node` 判空后才执行 —— cron 的默认 PATH 里没有固定版本 Node，
  于是**备份照做、清理静默跳过**（保留策略失效，磁盘只会一直涨）。
- 脚本放 `/opt/tally/scripts/`（**在 release 之外**，否则每次发布被覆盖）。上传后**必须**
  `chown -R root:root /opt/tally/scripts && chmod 0755 /opt/tally/scripts/*`：从 macOS 用 `tar`
  上传会带异常权限位（实测落到 `711`，`tally` 读不了 `.mjs` → 保留策略再次静默跳过）。
- 目录/日志准备（幂等；执行身份与下面 cron 一致）：
  ```bash
  install -d -o tally -g tally -m 0750 /var/lib/tally/backups/daily
  install -m 0640 -o tally -g tally /dev/null /var/log/tally-backup.log
  ```
- **验证方式不是"看一眼 crontab"**：先临时装一个 `* * * * *` 的调度真实触发一次，
  确认「新备份文件生成 + 日志写入 + 保留策略执行」三件事都发生，再换回正式的每日调度。
  cron 的环境变量、PATH、权限与交互式 shell 都不同，只配不验是这类任务最常见的翻车点。
- 备份脚本需要 `sqlite3` CLI 执行 `.backup`（本机 3.26 可用，见 4.4 的说明）；
  脚本里的完整性校验若用 `PRAGMA integrity_check`，在本机会失败 —— 请按 4.6 换成应用引擎校验，
  或把该步骤单独交给 Node 脚本。
- **异机副本**：本机一份不算备份。`/var/lib/tally/backups` 需再同步到异机/对象存储，
  并每月做一次真实恢复演练（[production-checklist.md](production-checklist.md) 第 8 节）。

## 8. 单实例约束（务必遵守）

周期账单调度与限流都是**进程内**状态，SQLite 也不支持多写者跨机共享：

- 同一时刻**只能有一个** `tally-backend` 进程持有 `/var/lib/tally/tally.db`。
- 需要横向扩容时，先迁到 PostgreSQL/MySQL 等共享存储，并给定时任务加分布式锁；
  在此之前请用「纵向扩容 + 单机」而不是多开进程。
