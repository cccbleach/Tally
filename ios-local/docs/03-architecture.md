# Tally 技术设计与架构

## 1. 系统架构
- **纯本地应用**：SwiftUI（UI）+ SwiftData（持久化）+ Swift Charts（图表）+ LocalAuthentication（锁）。
- 无网络层、无第三方依赖、无远程后端。
- 分层：
  - `App/` — 入口、Root 门控（onboarding → 锁 → 主界面）、AppState
  - `Models/` — SwiftData 实体（Ledger/Account/Category/Transaction/Budget/AppSettings）
  - `Core/` — Money、CurrencyInfo、DateRange、LockService（纯逻辑/工具）
  - `Services/` — Balance、Stats、Budget、CSV、Backup、SnapshotBuilder、SeedData（可测试业务逻辑）
  - `Views/` — 各页面
  - `TallyTests/` — 单元测试与真实 SwiftData 容器集成测试（Swift Testing）
  - `TallyUITests/` — 关键端到端流程（XCUITest）

## 2. 模块与数据流
- SwiftUI `@Query` + `ModelContext` 直接驱动 UI；计算结果（余额/统计/预算）均由 Service 现算，
  不冗余存储，避免「改了历史交易但汇总不同步」。
- AppState 仅存「本次会话当前账本」「是否锁定」等非持久 UI 态；默认账本是显式设置，临时切换不会暗改默认值。

## 3. SwiftData 实体与关系（删除规则）
| 实体 | 关键字段 | 关系/删除规则 |
|---|---|---|
| Ledger | name/icon/color/currencyCode/isDefault | 一对多；删除 cascade |
| Account | kind/currency/initialBalanceMinorUnits/isArchived | 属于 ledger；交易侧 **nullify**（删账户不删交易） |
| Category | name/icon/color/kind/isSystem/isEnabled | 属于 ledger；交易侧 **nullify** |
| Transaction | kind/amountMinorUnits/currency/date/note/payee/isDeleted/deletedAt | 属于 ledger；account(from/to)、category(nullify)；refund 自关联 |
| Budget | amount/categoryID/periodISO/isEnabled | 属于 ledger；删除 cascade |
| AppSettings | 单行：币种/每月起始日/外观/生物锁/onboarding/defaultLedger | — |

> 关键：删除账户/分类采用 **nullify** 而不是 cascade，保证「历史交易不悄悄丢失」；
> 用户删除的交易先**软删除**（isDeleted=true），可在「最近删除」恢复。

## 4. 金额策略（关键决策）
- **一律以最小货币单位整数存储**（如人民币分）：`Int64 minorUnits`。
- `Money` 值类型 + `CurrencyInfo`（code/symbol/minorUnits）负责解析与格式化。
- 禁止 `Double` 参与金额运算；`Decimal` 仅用于展示换算。
- 支持 CNY(2)、USD(2)、JPY(0)、EUR(2)、HKD(2)、TWD(2)、GBP(2)。
- 默认币种 CNY，但业务逻辑只用 `currencyCode`，绝不硬编码 `¥`。未知币种不会回退成 CNY。
- 一个账本及其账户、交易、预算必须使用同一币种；已有交易、预算或非零初始余额的账本禁止原地换币种。

## 5. 账户余额计算规则
`余额 = 初始余额 + Σ(入账) − Σ(出账)`，软删除交易排除：
- 支出：账户 −金额
- 收入/退款：账户 +金额
- 转账：转出账户 −金额，转入账户 +金额（净额为零，不计收支）
- `upTo date` 可选（用于历史时点余额）

## 6. 统计口径
- 收入 = 期内 `income`
- 支出 = 期内 `expense` − 期内 `refund`（退款抵扣当月支出）
- 结余 = 收入 − 支出
- 转账不计入收支；软删除一律排除
- 分类占比只统计支出（退款按原分类抵扣）
- 「每月起始日」可配置（1–31），周期区间为 `[start, nextStart)`

## 7. 预算计算规则
- `categoryID == nil` → 全账本总预算（对比总支出）
- `categoryID != nil` → 分类预算（只对比该分类净支出）
- `periodISO` 为空 = 每月重复；非空 = 仅当月
- 禁用预算不显示；`ratio = spent/limit`，≥1 变红提示超支，≥0.8 橙色提示接近

## 8. 退款处理
- 独立 `refund` 类型 + 可选 `refundOf → Transaction` 自关联。
- 余额：退款回到原账户；统计：抵扣当月支出；分类：按原分类。

## 9. 数据迁移策略
- 当前持久化基线是 `TallySchemaV1`，容器显式挂载 `TallyMigrationPlan`，不再依赖未记录的隐式模型变化。
- 当前 migration stages 为空，因为尚无 V2。任何存储字段/关系变化都必须新增 `VersionedSchema` 与 lightweight/custom `MigrationStage`，不得直接修改后发布。
- 发布前要求执行“旧版本建库并写入 → 安装新版本 → 验证实体/关系/统计”的升级测试；失败时展示启动错误，不自动清库。
- 版本化 JSON 备份是用户级可移植格式，不替代 SwiftData schema migration。详细流程见 `05-migration-plan.md`。

## 10. CSV 格式定义（UTF-8，首行表头，版本严格由表头识别）
CSV 版本**只根据表头判断**，绝不按数据行长度猜测。无表头输入直接报错。

### V1（旧格式，10 列）
```
type,date,amount,currency,account,counterAccount,category,payee,note,id
expense,2026-08-01,12.50,CNY,现金,,餐饮,食堂,午饭,<原支出UUID>
refund,2026-08-04,5.00,CNY,现金,,餐饮,食堂,退款,<原支出UUID>
```
- 非退款行的 `id` 是本交易自身稳定 UUID。
- **退款行的 `id` 是原支出的 UUID**；退款自身没有稳定 ID，导入时生成新 ID。
- 重复导入依赖完整语义键（含原支出 ID），不会把关联不同原支出的退款误判为重复。

### V2（当前导出格式，11 列）
```
type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
expense,2026-08-01,12.50,CNY,现金,,餐饮,食堂,午饭,<交易UUID>,
refund,2026-08-04,5.00,CNY,现金,,餐饮,食堂,退款,<退款UUID>,<原支出UUID>
```
- `id` **永远是当前交易自身**的稳定 UUID。
- `refundOfID` 是可选的**原支出** UUID；未关联原交易的退款允许为空。
- 绝不把 V2 退款自己的 ID 错当成原交易 ID。

### 解析与导入规则
- `date` 为 `yyyy-MM-dd`；`amount` 遵循币种小数位（本地时区）。
- 表头必须严格匹配 V1（10 列）或 V2（11 列）；字段缺失/重复/未知列/顺序错误都会明确报错；数据行字段数必须与识别的版本一致。
- 支持 BOM 表头、引号/逗号/换行字段。
- 导入先完整预检，再在单个 SwiftData transaction 中写入；**中途可注入故障并证明 rollback**，不留下账户、分类、交易或退款关系半成品。
- 重复 UUID 或无 UUID 的规范化内容用于幂等跳过；相同 UUID 若已存在其他账本则拒绝。账户/分类解析严格限定当前账本。
- **退款重复判定同时包含 `refundOfID`**：数据库已有退款 + 导入关联不同原交易的退款，不再被误判为重复；重复导入同一退款则幂等跳过；相同稳定 ID 内容不同仍明确报错。
- 导入要求上下文干净（`context.hasChanges` 为假），否则明确报错，绝不静默提交无关的未保存改动。
- 导入拒绝未知币种、与账本不一致的币种、非严格 `yyyy-MM-dd` 日期和无效关系。

## 11. 备份与恢复
- 完整 JSON：ledgers/accounts/categories/transactions/budgets/settings，全部经 DTO 层。
- 导出覆盖全部账本的全部交易（含软删除数据），不是只导出当前账本。
- **版本范围严格校验**：只接受 `1 ... currentVersion`；`version <= 0`、未来版本都明确拒绝，不会静默当 V1 处理。
- 恢复流程：完整 decode + 版本/ID/枚举/币种/跨账本引用/交易结构校验 → 单事务清空并重建；失败 rollback，不产生半写状态。**提供测试接缝可在“旧数据删除 + 至少一个新对象（新账本）已插入后”注入故障，证明真正的部分插入后 rollback 仍能恢复旧账本/账户/分类/交易/预算/设置全部原始 ID、名称与关系（含磁盘 store 重开验证），且不存在半写入的新对象。**
- 恢复要求上下文干净（`context.hasChanges` 为假），否则明确报错，绝不静默提交无关的未保存改动。
- 导出文件会提示包含敏感财务信息。

## 12. 错误处理 / 日志 / 安全
- 业务校验在前（金额>0、转账账户不同……），所有持久化失败都显示中文错误并 rollback；没有用 `try? save()` 伪装成功。
- 不写任何含金额/备注/账户的日志（本项目无日志框架）。
- 生物识别失败使用新的认证上下文回退设备密码；取消/失败绝不解锁。进入后台立即重锁，内容不会先闪现；Info.plist 包含 Face ID 用途文案。
- **重新启用边界**：`AppState.handleBiometricSettingChange(wasEnabled:isEnabled:)` 在生物识别锁从 false 变为 true 时立即设置 `isLocked = true`，RootView 随即切到 locked 路由并要求再次认证——即使同一次前台会话里刚刚认证过并处于解锁状态，开锁后也不会继续显示主界面；从 true 变为 false 可显示 main，但下次重新开启仍会立即锁定。
- 未来接分析必须明示字段/目的/退出方式（当前不接）。

## 13. 测试策略
- Swift Testing：99 条 / 11 套件。覆盖负数/逗号/溢出金额、月起始日 29–31（含真实存储统计边界）、币种变更与隔离、锁状态、**生物识别重新启用立即锁定**、**生物识别 Toggle 快速切换竞态（过期认证结果不会覆盖新意图）**、**隐私首帧路由（loading/onboarding/locked/main 纯状态决策）**、余额与安全删除策略、预算退款、CSV V1/V2 严格识别、备份版本范围、旧未版本化 store 兼容、原子清库重建等。
- SwiftData 集成：临时 SQLite 重启持久化；完整多账本备份与退款关系恢复；坏备份保留原数据；**备份/CSV 事务中途故障注入 rollback（备份回滚测试在新账本已插入后才触发故障；CSV 磁盘级中途失败回滚测试在真的磁盘 store 上验证原数据保留、无半写并重开 store 复核，含磁盘 store 重开验证）**；**未保存上下文不被静默提交**；CSV 幂等、**退款 duplicate key 含 refundOfID**、V1/V2 语义、跨账本隔离、未知币种和原子失败。
- XCUITest：2 条关键流程，覆盖首次引导→记支出→首页汇总，以及明细完整筛选入口。
- 真机、万级性能和完整 VoiceOver 人工流程仍是上架前项目，不在自动化通过范围内。

## 14. 里程碑对照
| 第 n 阶段 | 状态 |
|---|---|
| 1. 可构建最小项目 | ✅ |
| 2. 数据模型与迁移基础 | ✅ |
| 3. 创建交易→持久化→列表→统计 | ✅ |
| 4. 账户/分类管理 | ✅ |
| 5. 首页汇总 | ✅ |
| 6. 搜索筛选 | ✅ |
| 7. 统计图表 | ✅ |
| 8. 预算 | ✅ |
| 9. 导出/备份/导入/恢复 | ✅ |
| 10. 设置/隐私锁/无障碍 | ✅（基础） |
| 11. 测试 | ✅（单元 + SwiftData 集成 + 关键 XCUITest） |
