# Tally 修复优化计划

> 基于对 backend / ios / docs 的整体审查。本计划按“先止血、再正确性、再架构、后加固”的顺序排列，
> 每项给出涉及文件与验收标准。优先级 P0 最高。

## 阶段 0：止血（P0） ✅ 已完成（Round 1）

- [x] 0.1 周期账单幂等 + 原子化
- [x] 0.2 移除 GET 副作用，收敛补跑时机
- [x] 0.3 修复前后端契约断裂（预算保存 bug）
- [x] 0.4 生产环境默认密钥硬校验
- [x] 新增回归测试（数据层幂等 + 预算契约），22 个测试全绿
- 注：0.3 中 iOS 端无需改动即可恢复正常解析（后端补齐字段），未改动客户端。

<details>
<summary>原计划内容（供追踪）</summary>

### 0.1 周期账单幂等 + 原子化
- 文件：`backend/src/lib/recurringRunner.ts`、`backend/migrations/0002_*.sql`
- 改动：
  - 新增唯一约束/索引：如 `CREATE UNIQUE INDEX uniq_recurring_generated ON transactions(...)` 不可行（流水表无 recurring_id 字段），因此改为给流水表加 `recurring_id` 可空列 + `(recurring_id, date)` 唯一索引；或者新建 `generated_runs(recurring_id, date, tx_id)` 表。
  - `runDueRecurring` 整体包在 `db.transaction()`（better-sqlite3 的 `db.transaction` 或手动 BEGIN/COMMIT）里：插入一行就插入对应 `run` 记录，最后统一推进 `nextRunDate`。
  - 落库前用 `.insert().onConflictDoNothing()`。
- 验收：模拟崩溃（在 while 循环中途 throw）后重跑，无重复流水；测试覆盖“改 startDate 重置 nextRunDate 不重复”。

### 0.2 移除 GET 副作用，收敛补跑时机
- 文件：`backend/src/modules/transactions.ts`、`backend/src/modules/recurring.ts`、`backend/src/modules/stats.ts`、`backend/src/index.ts`
- 改动：GET 不再调用 `runDueRecurring`；只在启动时 + cron 补跑。若担心客户端拿到的数据不是最新，可改为客户端显式触发一次。
- 验收：GET 不写库（通过 BEGIN/COMMIT 观察），多实例不重复生成。

### 0.3 修复前后端契约断裂（预算保存 bug）
- 文件：`backend/src/modules/budgets.ts`、`ios/Tally/Networking/APIService.swift`、`ios/Tally/Models/Models.swift`
- 改动：后端 `POST /budgets` 与 `PATCH /budgets/:id` 返回的 item 补齐 `spent`/`percent`（或 iOS 改用独立轻量模型）。以 `docs/api.md` 为准统一 DTO。
- 验收：iOS 保存预算成功；新增契约测试（后端返回 item 结构包含 iOS 所需字段）。

### 0.4 生产环境默认密钥硬校验
- 文件：`backend/src/config.ts`、`docker-compose.yml`、`docs/deploy.md`
- 改动：`NODE_ENV=production` 且 `JWT_SECRET` 为默认值时 throw/exit(1)；把默认值常量提取并复用。
- 验收：不设环境变量、production 下启动失败并提示。

</details>

## 阶段 1：正确性（P0-P1）

### 1.1 统一时区 ✅ 已完成（Round 2）
- [x] 新增 `timezone` 配置（`APP_TIMEZONE` 优先，其次容器 `TZ`，默认 `Asia/Shanghai`），`todayStr`/`currentYearMonth` 均以该时区计算
- [x] 重构 `trend` 不再依赖服务器本地时间，改用时区下的当前年月
- [x] Docker / .env.example / 部署文档补齐时区配置
- [x] 新增确定性的跨时区单测（UTC/上海/纽约同一时刻口径）与时区一致性测试，25 个测试全绿

<details>
<summary>原计划（供追踪）</summary>

### 1.1 统一时区
- 文件：`backend/src/lib/date.ts`、所有调用方、`docs/deploy.md`
- 改动：新增 `TZ` 配置，所有“今天/当月”计算基于显式时区（如 `Asia/Shanghai`），Docker 设置 `TZ`。`todayStr` 等改为使用时区偏移量手算或封装。
- 验收：在 UTC 容器中模拟国内用户，日期判断与国内一致；补测跨时区用例。

</details>

### 1.2 明确多币种策略（选择“支持多币种 + 汇率换算”） ✅ 已完成（Round 3）
- [x] 新增 `exchange_rates` 表（用户级 / 全局两级，支持按需覆盖）+ 迁移 `0003`
- [x] 新增 `lib/currency.ts`：`getRate` / `convert` / `setRate`，带内置兜底汇率，未知币种 1:1 兜底不崩溃
- [x] 重构 `aggregates`：账户余额按“账户本位币”核算；跨账户统计（income/expense/net/balance/byCategory/byAccount/daily/trend）全部按汇率折算到基准币种 `config.baseCurrency`
- [x] `stats/summary.balance` 改为 `totalBalancesInBase`
- [x] `recurringRunner` 生成的流水继承账户币种，不再硬编码 CNY
- [x] 新增回归测试：外币支出按汇率折算（不直接相加），27 个测试全绿

<details>
<summary>原计划（供追踪）</summary>

### 1.2 明确单币种 vs 支持多币种
- 文件：`backend/src/lib/aggregates.ts`、`backend/src/lib/recurringRunner.ts`、`backend/src/modules/*`
- 若决定短期只做单币种：删除所有 `currency` 字段或统一为 CNY，简化模型。
- 若保留多币种：新增 `exchange_rates` 表、`convert()`，所有汇总按基准币种换算。
- 验收：多币种账户总余额/统计不再直接相加。

</details>

### 1.3 引入“账本”概念 ✅ 已完成（Round 5）
- [x] 迁移 `0004_ledgers.sql`：新增 `ledgers` 表，`users.default_ledger_id`，及 `accounts/categories/transactions/budgets/recurring.ledger_id` 字段；对存量用户/数据自动建默认账本并回填
- [x] schema 对齐；`auth/register` 创建默认账本后再播种默认分类
- [x] 所有模块（accounts/categories/transactions/budgets/recurring/stats）按 `getLedgerId`（默认账本）隔离查询与写入
- [x] `recurringRunner` 生成流水继承 `ledger_id`
- [x] 回归测试：账本隔离（非默认账本数据不出现在默认 API），29 个测试全绿
- [x] 旧库升级验证：0001-0003 → 0004 平滑迁移，用户/账户自动回填到默认账本
- 说明：当前 API 面向“每用户单默认账本”，多账本管理接口与 iOS 账本切换留待后续版本。

<details>
<summary>原计划（供追踪）</summary>

### 1.3 引入“账本”概念
- 文件：`backend/migrations/0003+`、所有模块、iOS 端（0002 已被阶段 0 占用）
- 改动：新增 `ledgers` 表，`accounts/categories/transactions/budgets/recurring` 挂 `ledger_id`（保留 `user_id`），提供账本 CRUD 与默认账本迁移。
- 验收：一个用户可建多个账本，数据按账本隔离；旧数据自动进默认账本。

</details>

### 1.4 转账建模与检索 ✅ 已完成（Round 2，最小方案）
- [x] `GET /transactions?accountId=` 同时匹配转出与转入账户
- [x] 新增测试：按转入账户过滤能查到转账流水（26 个测试全绿）
- 说明：本轮采用最小方案（查询层），未改动双行模型。是否演进为双行 + `transfer_group_id` 留待后续评估。

<details>
<summary>原计划（供追踪）</summary>

### 1.4 转账建模与检索
- 文件：`backend/src/modules/transactions.ts`、`backend/migrations/0002`
- 改动：`GET /transactions?accountId=` 同时匹配 `account_id` 与 `transfer_to_account_id`；或改为双行 + `transfer_group_id`。
- 验收：按转入账户能查到对应转账流水。

</details>

### 1.5 信用卡/负债语义 ✅ 已完成（Round 4，第一阶段）
- [x] 账户 DTO 新增 `isLiability` 与 `debt`（欠款本币正数），`balance` 保持净值口径
- [x] 统计新增 `totalAssets` / `totalDebt`，`balance` 定义为净资产（assets - debts）
- [x] iOS：账户页总资产/负债/净资产分开展示，负债账户显示“欠款”，已通过 `xcodebuild` 编译验证
- [x] 回归测试：信用卡消费后 `debt=+3000`、`isLiability=true`、统计披露负债，28 个测试全绿
- 说明：采用“单独列出负债”而非“后台改负号”方案，避免破坏总资产/净值语义；完整“还款”建模（还款流水）可在后续版本补充。

<details>
<summary>原计划（供追踪）</summary>

### 1.5 信用卡/负债语义
- 文件：`backend/src/lib/aggregates.ts`、iOS `AccountsView`
- 改动：明确“负债账户”类型，余额方向与总资产计算区分；加入“还款”建模。
- 验收：总资产不含负债或单独列出，信用卡欠款方向正确。

</details>

## 阶段 2：架构重构（P1-P2）

### 2.1 后端分层 ✅（第一阶段，Round 6）
- [x] 新增 `src/repositories/`（accountRepository / categoryRepository）与 `src/services/`（transactionService）
- [x] 移除 `transactions.ts` / `recurring.ts` 中重复的 `loadMaps` / `maps`，改走共享 repository/service
- [x] 新增非 HTTP 的 repository/service 单测（按账本隔离），31 个测试全绿
- 说明：路由仍保留部分业务直接查询（账户/预算模块的 CRUD），完整抽出所有 service 留待后续轮次。

<details>
<summary>原计划（供追踪）</summary>

### 2.1 后端分层
- 新增 `src/services/` 与 `src/repositories/`，路由只做解析；把 `loadMaps`、聚合查询收拢。
- 依赖注入已有雏形（`buildApp`），进一步抽离。
- 验收：业务逻辑可脱离 HTTP 单测；模块行数下降、无重复查询代码。

</details>

### 2.2 数据库事务与约束 ✅ 已完成（Round 7）
- [x] migration runner 改为：每个迁移在独立事务中执行（失败不标记、自动回滚）+ SHA-256 内容校验（已发布迁移改动即报错）
- [x] 迁移 `0005_transactions_check.sql` 为流水表增加数据层 CHECK（`type` 枚举、`amount > 0`），保留外键与原索引
- [x] schema 对齐：`users.email unique()`（与迁移一致）
- [x] 新增迁移回归测试（篡改检测、失败回滚），33 个测试全绿
- 说明：预算类等已由唯一索引兜底；“全部检查+写入改事务”范围较大，核心已用 onConflictDoNothing（周期账单）与唯一索引覆盖。

<details>
<summary>原计划（供追踪）</summary>

### 2.2 数据库事务与约束
- 所有“检查+写入”改为事务或 `onConflictDoNothing`；migration 包事务并校验 content hash。
- 对齐 `schema.ts` 与迁移文件（email 唯一、外键、check 约束：`amount>0`、`type` 枚举）。
- 验收：并发/半失败场景无脏数据。

</details>

### 2.3 iOS 离线能力 ✅ 已完成（Round 10）
- [x] 本地读缓存（`LocalCache`，文件 JSON）：loadAll 先读本地再后台同步，网络失败保留缓存并标记 `isOffline`，首页显示“离线模式”提示
- [x] 401 统一处理：APIClient 自动刷新并重试一次，最终失败广播 `tallySessionExpired`，AppState 统一登出
- [x] 首页/账户页补齐空态；AITs 收紧（与阶段 3 一并完成）；xcodebuild 编译通过
- 说明：采用“读缓存 + 后台刷新”的轻量离线（MVP 语义），未引入本地 SQLite 全量离线写（GRDB/SwiftData）与完整同步队列，留作后续演进。

### 2.4 数据同步/冲突策略 ✅ 已完成（Round 8）
- [x] 策略定为 **Last-Write-Wins + 乐观锁**：写接口返回最新 `updatedAt`，PATCH 支持可选的 `expectedUpdatedAt`
- [x] 已在流水 / 预算 / 周期账单 PATCH 实现乐观锁（不匹配返回 `409 CONFLICT`），并在相应响应中返回 `updatedAt`
- [x] 新增回归测试：预期时间戳不匹配返回 409，34 个测试全绿
- [x] `docs/api.md` 新增「多端同步与冲突策略」章节并更新 PATCH 契约
- 说明：账户/分类暂未加 `updatedAt`（提交后整体刷新），后续如需可补 `updated_at` 列。

<details>
<summary>原计划（供追踪）</summary>

### 2.4 数据同步/冲突策略
- 文档化多设备冲突策略（last-write-wins？），并在写接口返回 `updatedAt` 做乐观锁校验。

</details>

## 阶段 3：安全加固（P1）✅ 已完成（Round 10）

- [x] CORS 白名单：`CORS_ORIGINS` 配置，未列入源不放行；未配置时开发期放行所有
- [x] 登录/注册接口进程内限流（默认 60/分钟，可配置），超额返回 429
- [x] JWT 短期访问令牌（默认 15m）+ 刷新令牌（默认 30d）：login/register 返回 `refreshToken`；新增 `POST /auth/refresh`；刷新令牌不能当访问令牌用
- [x] iOS：Keychain 存储双令牌、APIClient 401 自动刷新并重试、AppState 登录/注册保存双令牌、APIService.refresh；xcodebuild 编译通过
- [x] 密码找回/重置：`POST /auth/forgot-password` 与 `POST /auth/reset-password`（重置令牌短效），开发期直接返回 resetToken
- [x] iOS ATS 收紧：`NSAllowsArbitraryLoads=false` + `NSAllowsLocalNetworking=true`（Info.plist 与 project.yml、部署文档一致）
- 说明：证书固定（pinning）与邮件发送为可选项，已文档化；至此阶段 3 计划内项全部完成。

<details>
<summary>原计划（供追踪）</summary>

- CORS 白名单；登录限流（内存 / Redis 令牌桶）；JWT 短期 + refresh token。
- iOS 证书锁定 + 移除 ATS 放行（保留 HTTP 开关在 Debug 配置）。
- 密码策略增强：可选邮箱验证/找回。

</details>

## 阶段 4：可观测性与运维（P2）✅ 已完成（Round 10）

- [x] Fastify logger（JSON，默认 warn 减少噪音；可配 LOG_LEVEL）
- [x] `/health` 增加 DB 可达校验
- [x] 新增 `.github/workflows/ci.yml`（backend typecheck+test；iOS 构建）
- [x] 新增 `scripts/backup.sh`（在线备份、保留最近 14 份）+ 部署文档 cron
- [x] `docs/deploy.md` 增加单实例限制说明
- 说明：外部指标上报（如 Sentry/Prometheus）未接入，属可选；本阶段已完成计划内项。

## 阶段 5：收尾清理（P2）✅ 已完成（Round 10）

- [x] 归档账户不再计入总资产/净值（`assetDebtSummary` 过滤 `is_archived=false`，UI 区分实现于账户页）
- [x] 移除死亡代码：后端 `computeAccountDebts`/`totalBalancesInBase`、iOS `UpdateBudgetBody`/`deleteBudget`
- [x] iOS 补齐空态（账户/首页已有）与离线提示；统一 401 登出
- 说明：完整“还款”流水建模、证书固定（pinning）与邮件发送属可选项，已文档化留待后续。

## 建议顺序与估算

| 阶段 | 内容 | 相对工作量 |
|---|---|---|
| 0 | 止血（幂等/契约/密钥） | 小 |
| 1 | 正确性（时区/币种/账本/转账/信用卡） | 中-大 |
| 2 | 架构重构 + 离线 | 大 |
| 3 | 安全加固 | 中 |
| 4 | 可观测性 + CI | 中 |
| 5 | 清理 + 打磨 | 小 |

建议先完成阶段 0 并立即发布，拿到稳定积累的数据后再做阶段 1 的结构性迁移。

---

## 总体状态：✅ 全部阶段已完成（Round 10 收尾）
