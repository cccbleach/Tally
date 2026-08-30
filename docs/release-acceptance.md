# Tally 生产发布验收记录（Release Acceptance Evidence）

> 本文件记录「生产发布准备」各项验收的实际执行证据与复现命令，作为上线前审计凭据。
> 关联清单见 [`production-checklist.md`](./production-checklist.md)。所有验收均在**不重构业务逻辑**的前提下完成。

- 仓库基线：`main` @ `8b6a62e`（功能交付）+ `269e83c`（CI 断言脚本收敛）+ `b37af9a`（验收记录固化）；本轮在基线之上修复评审发现的真实缺口
- 验收环境：macOS 主机 + lima `vz`/aarch64 虚拟机内真实 Docker Engine 29.7.2；Xcode（iPhoneSimulator26.5 SDK）；Node 24；pnpm 11.19.0
- 状态：**全部通过，工作区干净；补充缺口已闭环（见第 0 节）**

---

## 0. 补充验收：真实缺口的修复与闭环 ✅

本轮针对评审发现的真实发布缺口逐一闭环，全部在真实 Docker/Node 环境复测（**非仅 `compose config`**）。

### 0.1 caddy:2 healthcheck 修复（镜像内无 bash）

- 问题：官方 `caddy:2` 是 Alpine/busybox 基础镜像，**镜像里没有 bash**；原 healthcheck 用 `bash -c '</dev/tcp/…'`（bash 专属语法）执行 → 永远失败，Caddy 永远到不了 `healthy`，`depends_on: service_healthy` 链路也随之卡死。
- 修复：改用镜像**实际自带**的 busybox `nc` 做零 I/O TCP 探活：
  `nc -z -w 3 127.0.0.1 80 && nc -z -w 3 127.0.0.1 443`
  （已在该镜像实测：`nc -z` 对开放端口返回 0、对关闭端口返回 1。）
- 源文件：`backend/docker-compose.caddy.yml`。

### 0.2 真实容器级回归（完整 HTTPS 栈 + /health/ready）

在真实 Docker Engine 29.7.2（lima VM）用**完整** `docker-compose.caddy.yml` 拉起并验证：

```bash
# 在 backend/ 下
export TALLY_DOMAIN=localhost JWT_SECRET=$(openssl rand -hex 32)
docker compose -f docker-compose.caddy.yml up -d --build
docker compose -f docker-compose.caddy.yml ps
# tally-backend: Up ... (healthy)
# tally-caddy:   Up ... (healthy)
node ../scripts/check-compose-live.mjs ../backend/docker-compose.caddy.yml
```

实测结果（**容器级、非静态校验**）：

- `tally-backend`：`running` / `healthy` ✅
- `tally-caddy`：`running` / `healthy` ✅（证明修复后的 healthcheck 真能通过）
- HTTPS 反代端到端：`curl -k https://localhost/health/ready` → `200 {"status":"ok","migrationsApplied":20,…}` ✅
- HTTP→HTTPS 跳转：`http://localhost/health/live` → `308` → `https://localhost/health/live` ✅
- `tally-backend` 未向宿主发布端口（宿主直连 `localhost:8080` 不可达）✅
- 已沉淀为 CI 步骤「真实容器级回归（完整 HTTPS 栈：双服务 healthy + HTTPS /health/ready）」+ 共享脚本 `scripts/check-compose-live.mjs`（含 running/healthy、暴露面、HTTPS 反代三重断言），防止再次回归到“只做 compose config”。

### 0.3 空白/EOF 卫生

- 删除 `docs/production-checklist.md` 尾部多余空行（原文件以 2 个空行结尾，`git diff --check` 报 `new blank line at EOF`）。
- 已复检：修复后 `git diff --check`（工作区+暂存区）通过；提交后 `git diff 73a7a3d..HEAD --check` 通过（见第 8 节）。

### 0.4 Excel worker 与并发 worker 测试 FD warnings 全部清零（源级修复，无全局屏蔽）

- 根因：测试/开发环境由 `tsx` 注入 ESM loader（`--import loader.mjs`），worker 线程继承后，Node 会在 worker 内通过 ESM loader 的 `getSourceSync` 读取入口文件，把 fd 标成 “unmanaged mode”，批量打印 `File descriptor … opened/closed in unmanaged mode`。实测 `test/billParser.test.ts` 与 `test/loanIdempotencyConcurrency.test.ts` 合计约 1028 条。
- Excel worker（`src/lib/billParser.ts`）：纯 CommonJS（`.cjs`），创建 worker 时显式 `execArgv: []`，不继承任何 loader → 0 告警。
- 并发 worker（`test/loanConcWorker.ts` → 改为 **`test/loanConcWorker.cjs`**）：并发测试仍需真正独立的 worker 线程跑 Fastify + 独立 SQLite，但把 worker 入口改为纯 CommonJS，并在创建时只注入 tsx 的 **CJS require 钩子**（`execArgv: ["--require", require.resolve("tsx/cjs")]`），完全不走 ESM loader；钩子内用显式 `.ts` 扩展 `require` 源码即可加载 TypeScript 模块 → **0 告警**。
- **未使用** 任何 `NODE_OPTIONS=--disable-warning` / 全局屏蔽 Warning。`package.json` 的 `test` 命令保持朴素 `tsx --test test/*.test.ts`。
- 复测（**不屏蔽任何 Warning** 的 `pnpm exec tsx --test test/*.test.ts`）：**105/105 通过，FD warning = 0**（修复前约 1028 条）。

### 0.5 账号枚举与短信供应商响应日志的安全复核

- 账号枚举逐端点复核（结论已写入 `backend/src/auth/routes.ts` 注释）：
  - 密码登录：账号不存在与密码错误返回完全相同的 401 → 不枚举。
  - 验证码登录 `/request-code`：未注册也返回 `{ok:true}` → 不枚举。
  - 找回密码 `/reset-code`：未注册返回 404 —— **有意保留的风险豁免**：项目无邮件/站内通道，若对未注册账号谎称“已发送”，用户将永远等不到验证码；已由 IP+账号双维度限流缓解，风险已明确记录（代码注释 + 本文档）。
- 短信供应商响应日志脱敏：`src/lib/sms.ts` 的 `sanitizeSmsBody` 把**手机号与明文验证码都视为个人信息（PII）**一并遮蔽——`phoneNumber` / `phone` / `verifyCode` 及其嵌套字段统一替换为 `****`，覆盖 `sendVerifyCode` 失败日志与 `checkVerifyCode` 响应日志；保留 `success/requestId/code/message/verifyResult` 等排障字段；成功路径维持“敏感信息不落日志”。

---

## 1. docker compose config ✅

复现命令（连真实 daemon）：

```bash
DOCKER_HOST=unix://<用户名>/.lima/tally/sock/docker.sock \
DOCKER_CONFIG=/tmp/dockercfg \
JWT_SECRET='<非空32字节以上>' TALLY_DOMAIN='staging-api.tallyapp.cn' \
docker compose -f backend/docker-compose.caddy.yml config --quiet          # exit 0
docker compose -f backend/docker-compose.caddy.yml config --format json \
  | node scripts/check-compose-topology.mjs                                # ✅ 拓扑合规
```

实测断言结果：

- `tally-backend` 发布到宿主的端口：`[]`（8080 仅 Docker 内网，不暴露公网）
- `caddy` 发布到宿主的端口：`["443","80"]`（仅此两个）
- 网络：backend 与 caddy 同属 `tally-edge`（非 internal）
- 命名卷：`tally-data`、`caddy_data`、`caddy_config`
- 每个服务均具备 `healthcheck`、`restart: unless-stopped`、持久卷
- 缺 `JWT_SECRET` 或 `TALLY_DOMAIN` 时 `docker compose config` 直接失败（exit 1，防弱默认值上线）

## 2. docker image build ✅

在真实 Docker Engine 29.7.2（lima VM）内构建：

```bash
docker build -t tally-backend:release-check backend   # BUILD_EXIT=0
docker images | grep tally-backend                    # tally-backend:release-check 1.13GB
```

运行冒烟（构建出的镜像）：

```bash
docker run -d -e JWT_SECRET=... -p 18080:8080 tally-backend:release-check
curl http://127.0.0.1:18080/health/live   # 200
curl http://127.0.0.1:18080/health/ready  # {"status":"ok","migrationsApplied":20,...}
```

## 3. backend 全量验收 ✅

- `pnpm typecheck` 通过
- `pnpm test`：**105 个测试全部通过，0 条 FD 告警**（详见 0.4）
- `pnpm audit --audit-level=high --prod`：**0 个高危**
- `pnpm build` 通过；`node scripts/smoke-dist-xlsx.mjs`（dist 产物 smoke）通过
- 生产 dist 启动冒烟：迁移全部应用（migrationsApplied=20）
- 账号恢复生产语义：短信网关不可用→`503 SMS_SEND_FAILED`；未知手机号→`404 ACCOUNT_NOT_FOUND`；邮箱账号→`400 EMAIL_RECOVERY_UNAVAILABLE`；遗留 `forgot-password` 路由→`404`；错误验证码→`400`（旧密码仍可登录，杜绝「返回成功但用户拿不到 token」）

## 4. 联网版 iOS Debug / Release ✅

- Debug：`TALLY_API_BASE_URL=http://localhost:8080`，构建成功
- Release：不注入 URL 时构建**直接失败**（报「API 地址不合规：地址为空」）
- Release 注入 `https://staging-api.tallyapp.cn` 后构建成功；Archive 成功（版本 1.0.0）
- 产物 `Info.plist` 校验：`ios/scripts/validate-api-url.sh --plist` 通过（`VALIDATOR_RC=0`）
  - 本地预构建凭据：产物 `TallyAPIBaseURL=https://api.tallyservice.dev`，非占位、HTTPS、条规

## 5. ios-local 全量测试 ✅

```bash
xcodebuild -project ios-local/TallyLocal.xcodeproj -scheme Tally \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -allowProvisioningUpdates test
```

结果（DEVELOPMENT_TEAM 配置变更后复跑）：

- **100 个 Swift Testing 测试（11 个套件）全部通过**
- **2 个 XCUITest 全部通过**
- `** TEST SUCCEEDED **`（EXIT=0）

## 6. Release 产物非占位 HTTPS URL ✅

- 源码无默认兜底域名（曾经的 `https://api.example.com` 兜底已删除）
- Release 构建在 URL 为空/非 HTTPS/localhost/纯 IP/单标签/占位词/保留后缀时直接失败
- 产物 Info.plist URL 与二进制 `http://(localhost|127...|0.0.0.0)` 均已校验

## 7. 发布资产与可交付性 ✅

- `ios-local` 正式 AppIcon：实测 `1024×1024`、`RGB`、`alpha=False`，已提交 Git
- 签名：`CODE_SIGN_STYLE=Automatic`、`DEVELOPMENT_TEAM=XN5LYQCCY2`、本机证书存在（`security find-identity` 通过）；CI Archive 使用 `CODE_SIGNING_ALLOWED=NO`（无签名凭据环境）
- 关键交付文件（compose/Caddyfile/校验收脚本/图标/重置页/CI/清单）全部纳入 Git 并带正确可执行位
- `.gitignore` 已含 `**/xcuserdata/`、`**/*.xcuserstate`、`*.xcresult/`、`*.xcarchive/`

## 8. 构建与测试后 git status 干净 ✅

- `git status --porcelain` 为空
- `git diff --check`（工作区+暂存区）通过
- **提交后 `git diff 73a7a3d..HEAD --check` 通过**（67…→ HEAD 无任何空白错误，见 0.3）
- Git 索引中 `xcuserdata` 文件数：**0**

---

## 上线前须由运维/发布者在目标环境重新执行的项

以下属环境/机密相关，本机已用等价值验收，上线时于生产/CI 复核：

1. `TALLY_DOMAIN`、`JWT_SECRET`、`ALIYUN_SMS_*` 注入真实值，且 `docker compose config` 通过
2. Caddy 首次启动签发真实证书（DNS 已指向服务器，80/443 可达）
3. 生产 `TRUST_PROXY=1`、CORS 白名单为真实前端域名、`JWT_SECRET` 为强随机且已备份
4. 迁移前数据库备份 + 异机恢复演练（见 production-checklist.md）
