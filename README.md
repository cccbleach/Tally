# Tally — iOS 记账 App

原生 SwiftUI iOS 客户端 + 自建 Node.js 后端的记账应用。支持收支流水、分类、统计图表、预算、多账户与周期账单，数据通过自建后端实现多设备同步。

## 功能

- 📒 **收支流水**：记录收入/支出/账户间转账，按日分组展示
- 🏷 **分类**：内置中文默认分类，支持自定义
- 📊 **统计图表**：分类占比饼图、每日收支、近 6 个月趋势（Swift Charts）
- 🎯 **预算管理**：总预算 + 分类预算，进度条与超支提醒
- 💳 **多账户**：现金/银行卡/电子钱包/信用卡，实时余额，账户间转账
- 🔁 **周期账单**：房租、订阅等定期账单自动生成流水（每日调度，幂等）
- 📥 **账单导入**：支持导入微信/支付宝/银行导出的账单文件（txt/csv/xlsx/pdf），服务端解析并跨来源去重入库（重复导入不重复入账）
- 👥 **共享账本**：明细页顶部一键切换个人/共享账本，按唯一昵称邀请成员共同记账
- 🏦 **负债管理**：车贷/房贷等额本息还款计划、信用卡额度/账单日/还款日、负债中心

## 技术栈

| 端 | 技术 |
|---|---|
| iOS | SwiftUI + Swift 5（语言模式），iOS 17+，MVVM（`@Observable` + async/await），Swift Charts |
| 后端 | Node.js 24 + TypeScript + Fastify |
| 数据库 | SQLite（单文件）+ Drizzle ORM |
| 认证 | 手机号 + 短信验证码统一登录；新账号强制设置**全局唯一公开昵称**。无密码、无密码重置、无邮箱认证（旧邮箱/密码流程已下线，后端统一返回 410）；JWT（`jose`）。恢复只有短信这一条路（见 docs/api.md） |
| 校验 | zod |
| 工程 | XcodeGen 声明式生成 `.xcodeproj` |

金额统一以「分」为整数存储与传输，避免浮点误差。

## 目录结构

```
Tally/
├── backend/                 # Node.js + TypeScript + Fastify 后端
│   ├── src/                 # 源码（auth/db/modules/lib）
│   ├── migrations/          # SQL 迁移
│   ├── test/                # 集成测试（node:test + fastify.inject）
│   ├── Dockerfile
│   ├── docker-compose.yml               # 只跑后端（8080 不发布到宿主）
│   ├── docker-compose.caddy.yml         # 生产 HTTPS 栈：Caddy 只暴露 80/443 + 后端仅内网
│   ├── Caddyfile                        # 生产 Caddy 配置（站点地址由 TALLY_DOMAIN 注入）
│   ├── Caddyfile.example                # 在服务器上手工跑 Caddy 时的模板
│   └── package.json
├── ios/
│   ├── project.yml          # XcodeGen 声明
│   ├── Tally.xcodeproj      # 已生成，可直接用 Xcode 打开
│   ├── scripts/validate-api-url.sh  # Release 域名校验（构建期 + 产物 Info.plist 复核）
│   └── Tally/               # SwiftUI 源码
├── ios-local/               # 离线优先的个人记账版（独立工程，见其 README，勿与本目录混改）
├── scripts/
│   ├── backup.sh / restore.sh / prune-retention.mjs   # 备份、恢复、保留策略
│   └── check-ios-release-assets.sh  # 图标/版本号/Bundle ID/签名 的发布资产检查
└── docs/
    ├── api.md                   # API 契约（含「账号恢复只做短信、不做邮件」的说明）
    ├── deploy.md                # 部署指南
    ├── https-deploy.md          # HTTPS/Caddy 上线步骤
    ├── openapi.yaml             # OpenAPI 契约（被测试校验）
    └── production-checklist.md  # ★ 生产上线清单（域名/TLS/JWT/CORS/备份/告警）
```

> **ios/ 与 ios-local/ 的定位（唯一源码来源）**
> - `ios/`：本仓库在线版 iOS 客户端，连接 `backend/` API，是本文档指向的**唯一在线客户端源码来源**。
> - `ios-local/`：一个**相互独立的离线优先** iOS 项目（无账号、SwiftData 本地存储），自带工程/测试/文档，
>   与本仓库的 `ios/` 和 `backend/` 互不影响。为避免双目录漂移，两边改动请分别在各自工程内进行、
>   不要互相复制代码；本仓库后续维护以 `ios/` 为准。

## 快速开始

### 1. 启动后端

```bash
cd backend
cp .env.example .env          # 按需修改 JWT_SECRET
pnpm install
pnpm dev                      # 开发模式（tsx watch），默认 http://localhost:8080
```

验证：`curl http://localhost:8080/health` 返回 `{"status":"ok",...}`。

> 本机需 Node.js ≥ 22 与 pnpm。首次 `pnpm install` 会构建 `better-sqlite3` 原生模块（已通过 `pnpm-workspace.yaml` 放行）。

### 2. 运行 iOS App（需 Mac + Xcode）

```bash
open ios/Tally.xcodeproj   # 直接用 Xcode 打开（.xcodeproj 已生成）
```

- 在 Xcode 中选择模拟器或真机，点击运行。
- API 地址由**构建配置注入**（不在 App 内配置）：Debug 默认 `http://localhost:8080`；
  **Release 没有默认值**，必须显式注入真实 HTTPS 域名，否则构建直接失败：
  ```bash
  xcodebuild -project ios/Tally.xcodeproj -scheme Tally -configuration Release \
    -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO \
    TALLY_API_BASE_URL=https://your-domain.cn
  ```
  校验规则见 `ios/scripts/validate-api-url.sh`（禁止 localhost / 私网 IP / `example.com` / `your-*` 等占位）。
- 若改动了 `ios/project.yml` 或源文件增删，可重新生成工程：

```bash
brew install xcodegen        # 或下载二进制
cd ios && xcodegen generate
cd .. && ./scripts/check-ios-build-settings.sh ios/Tally.xcodeproj Tally
```

`ios/project.yml` 显式保存 Debug/Release 的关键编译设置，不依赖 XcodeGen 的外部
setting presets。生成过程不应出现 `No "... settings found"`，校验脚本会阻止
`DEBUG` 条件或 Release 优化被重生成过程静默删除。

## 测试

```bash
cd backend
pnpm typecheck
pnpm test        # 142 个测试：手机号+短信验证码认证/强制唯一昵称/共享账本/账户/分类/流水/统计/预算/周期账单/贷款/去重
                 # （含幂等、OpenAPI 契约、时区、转账检索、汇率换算、负债语义、账本隔离、分层、
                 #  迁移校验（22 个迁移）、乐观锁、并发回归、故障注入、限流与 TRUST_PROXY、
                 #  生产模式安全策略、账单导入去重等回归，全部 0 fail）
```

iOS 侧（需 Xcode）：

```bash
# 联网版：Debug + Release（Release 必须注入真实 HTTPS 地址）
xcodebuild -project ios/Tally.xcodeproj -scheme Tally -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -configuration Debug build CODE_SIGNING_ALLOWED=NO
# 离线版：全量单测 + UI 测试
xcodebuild -project ios-local/TallyLocal.xcodeproj -scheme Tally \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
# 发布资产（图标 / 版本号 / Bundle ID / 签名）
./scripts/check-ios-release-assets.sh ios Tally
./scripts/check-ios-release-assets.sh ios-local Tally
```

CI（`.github/workflows/ci.yml`）覆盖：后端 typecheck / test / audit / build / dist smoke /
`docker build` / `docker compose config`（并断言只暴露 80/443、后端不对宿主发布端口）、
联网版 iOS Debug+Release（含 Release 产物 Info.plist 非占位 HTTPS 校验、无效地址必须构建失败）、
离线版 iOS 真机构建 + 全量测试 + Archive、`git diff --check`、以及构建后 `git status` 必须干净。

## 部署

- **上线必读**：[docs/production-checklist.md](docs/production-checklist.md) —— 域名/TLS/JWT/CORS/TRUST_PROXY、
  迁移前备份、异机备份与恢复演练、健康检查/日志/告警、iOS 发布资产与发布流程。
- 部署方式：[docs/deploy.md](docs/deploy.md)（Docker 一键、直接运行、pm2）。
- 生产 HTTPS（推荐）：`cd backend && TALLY_DOMAIN=... ACME_EMAIL=... JWT_SECRET=... docker compose -f docker-compose.caddy.yml up -d --build`
  —— Caddy 只发布 80/443，后端 8080 仅在 Docker 内网可达（见 [docs/https-deploy.md](docs/https-deploy.md)）。

## API

完整契约见 [docs/api.md](docs/api.md)。要点：

- 前缀 `/api/v1`，除认证外均需 `Authorization: Bearer <token>`
- 金额为整数「分」，日期 `YYYY-MM-DD`，错误统一 `{error:{code,message}}`

## 默认分类

注册时自动播种：餐饮、交通、购物、居住、娱乐、医疗、教育、人情、其他支出、工资、理财、其他收入。

## 安全说明

- 无密码体系：账号身份为手机号（E.164）+ **全局唯一公开昵称**，不存 `password_hash`；旧邮箱/密码、找回密码路由已整体下线（后端统一返回 `410 AUTH_METHOD_REMOVED`）
- JWT 密钥来自环境变量，生产务必改为强随机值（占位/过短密钥**生产模式拒绝启动**）
- App 开发期放行本地 HTTP 仅用于调试（ATS 只开 `NSAllowsLocalNetworking`），上线必须 HTTPS
- **账号恢复只有短信验证码这一条路**：无 SMTP、无邮件找回；生产环境短信发不出去就返回 503，绝不出现「返回成功但用户拿不到验证码」
- 生产模式验证码永不经响应回传；限流按「IP + 账号」双维度，反代后需设 `TRUST_PROXY`
- 每个响应带 `x-request-id`，关键写操作进 `audit_logs` 审计表

## 发布前自检（最小集）

```bash
cd backend
pnpm typecheck && pnpm test && pnpm build && node scripts/smoke-dist-xlsx.mjs
JWT_SECRET=$(openssl rand -hex 32) TALLY_DOMAIN=your-domain.cn ACME_EMAIL=ops@example.com \
  docker compose -f docker-compose.caddy.yml config --quiet
docker build -t tally-backend:latest .
cd .. && ./scripts/check-ios-release-assets.sh ios Tally && ./scripts/check-ios-release-assets.sh ios-local Tally
git diff --check && git status --porcelain    # 两者都必须为空
```
