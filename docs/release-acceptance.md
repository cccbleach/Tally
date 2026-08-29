# Tally 生产发布验收记录（Release Acceptance Evidence）

> 本文件记录「生产发布准备」各项验收的实际执行证据与复现命令，作为上线前审计凭据。
> 关联清单见 [`production-checklist.md`](./production-checklist.md)。所有验收均在**不重构业务逻辑**的前提下完成。

- 仓库基线：`main` @ `8b6a62e`（功能交付）+ `269e83c`（CI 断言脚本收敛）
- 验收环境：macOS 主机 + lima `vz`/aarch64 虚拟机内真实 Docker Engine 29.7.2；Xcode（iPhoneSimulator26.5 SDK）；Node 24；pnpm 11.19.0
- 状态：**全部通过，工作区干净**

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
- `pnpm test`：**105 个测试全部通过**
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
- Git 索引中 `xcuserdata` 文件数：**0**

---

## 上线前须由运维/发布者在目标环境重新执行的项

以下属环境/机密相关，本机已用等价值验收，上线时于生产/CI 复核：

1. `TALLY_DOMAIN`、`JWT_SECRET`、`ALIYUN_SMS_*` 注入真实值，且 `docker compose config` 通过
2. Caddy 首次启动签发真实证书（DNS 已指向服务器，80/443 可达）
3. 生产 `TRUST_PROXY=1`、CORS 白名单为真实前端域名、`JWT_SECRET` 为强随机且已备份
4. 迁移前数据库备份 + 异机恢复演练（见 production-checklist.md）
