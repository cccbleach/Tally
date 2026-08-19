# Tally — iOS 记账 App

原生 SwiftUI iOS 客户端 + 自建 Node.js 后端的记账应用。支持收支流水、分类、统计图表、预算、多账户与周期账单，数据通过自建后端实现多设备同步。

## 功能

- 📒 **收支流水**：记录收入/支出/账户间转账，按日分组展示
- 🏷 **分类**：内置中文默认分类，支持自定义
- 📊 **统计图表**：分类占比饼图、每日收支、近 6 个月趋势（Swift Charts）
- 🎯 **预算管理**：总预算 + 分类预算，进度条与超支提醒
- 💳 **多账户**：现金/银行卡/电子钱包/信用卡，实时余额，账户间转账
- 🔁 **周期账单**：房租、订阅等定期账单自动生成流水（每日调度，幂等）

## 技术栈

| 端 | 技术 |
|---|---|
| iOS | SwiftUI + Swift 5（语言模式），iOS 17+，MVVM（`@Observable` + async/await），Swift Charts |
| 后端 | Node.js 24 + TypeScript + Fastify |
| 数据库 | SQLite（单文件）+ Drizzle ORM |
| 认证 | 邮箱密码 + JWT（`jose`），密码用 `crypto.scrypt` 加盐哈希 |
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
│   ├── Dockerfile / docker-compose.yml
│   └── package.json
├── ios/
│   ├── project.yml          # XcodeGen 声明
│   ├── Tally.xcodeproj      # 已生成，可直接用 Xcode 打开
│   └── Tally/               # SwiftUI 源码
└── docs/
    ├── api.md               # API 契约
    └── deploy.md            # 部署指南
```

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
- 模拟器后端地址默认 `http://127.0.0.1:8080`；**真机**请改成 Mac 的局域网 IP（App 内「设置 → 服务器地址」），并确保同一局域网可达。
- 若改动了 `ios/project.yml` 或源文件增删，可重新生成工程：

```bash
brew install xcodegen        # 或下载二进制
cd ios && xcodegen generate
```

## 测试

```bash
cd backend
pnpm typecheck
pnpm test        # 40 个测试，覆盖认证/账户/分类/流水/统计/预算/周期账单（含幂等、契约、时区、转账检索、汇率换算、负债语义、账本隔离、分层、迁移校验、乐观锁、安全/令牌刷新/密码重置等回归）
```

## 部署

见 [docs/deploy.md](docs/deploy.md)：Docker（一键）、直接运行、pm2 三种方式；含 HTTPS 与数据备份说明。

## API

完整契约见 [docs/api.md](docs/api.md)。要点：

- 前缀 `/api/v1`，除认证外均需 `Authorization: Bearer <token>`
- 金额为整数「分」，日期 `YYYY-MM-DD`，错误统一 `{error:{code,message}}`

## 默认分类

注册时自动播种：餐饮、交通、购物、居住、娱乐、医疗、教育、人情、其他支出、工资、理财、其他收入。

## 安全说明

- 密码使用 `scrypt` 加盐哈希，不存明文
- JWT 密钥来自环境变量，生产务必改为强随机值
- App 开发期放行 HTTP 仅用于本地调试，上线请启用 HTTPS（见部署文档）
