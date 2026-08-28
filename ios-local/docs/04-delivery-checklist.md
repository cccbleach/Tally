# Tally 可靠 MVP 交付与验证清单

> 最终复核：2026-08-26。当前加固只修改 `ios-local/`；没有触碰 `ios/`、`backend/` 或根 README 中已有的用户/先前改动。
> 作用域证明采用**文件内容级 SHA-256**：除 `ios-local/` 外所有已修改/未跟踪文件生成「路径 + 内容 SHA-256」清单（排除 `.git/`、node_modules、DerivedData 与构建缓存），连同 outscope 二进制补丁哈希与根 README SHA-256，前后 `cmp` 一致——不只是 `git status` 路径集合相同。
> 注意：仓库根工作树仍包含用户原有改动及未跟踪 `ios-local/`，因此不声称 “clean tree”；“commit-ready” 仅指 `ios-local/` 无临时构建产物、无密钥、无第三方依赖、文档与真实结果一致。

## 1. 本轮关键修复

- 隐私锁：失败/取消不解锁，后台重锁，设置未加载时也显示中性占位而非主界面（彻底杜绝内容闪现）；补齐 Face ID 用途文案；数据库启动失败不自动清库。
- **生物识别重新启用立即锁定**：新增 `AppState.handleBiometricSettingChange(wasEnabled:isEnabled:)`，当 `biometricLockEnabled` 从 false 变为 true 时立即 `isLocked = true` 并切到 locked 路由，即使同一次前台会话刚刚认证过；true → false 可显示 main，但下次重新开启仍会立即锁定；成功认证后返回 main、失败/取消保持 locked、后台重锁逻辑保持不变。
- **生物识别 Toggle 竞态修复**：新增 `BiometricToggleCoordinator`（internal、强类型），所有 Toggle 切换都带 generation 防过期：开启认证结果返回时若用户已再次切换（例如开→关、开→关→开），旧认证结果直接丢弃，绝不用过期结果覆盖新意图；配套 2 条确定性异步测试。
- 隐私首帧路由：抽出 `RootRouteResolver`（loading/onboarding/locked/main）纯状态决策，并对首帧状态做了自动化回归（含「settings 从 nil 加载为需要锁定时中间不经过 main」）。
- 金额/日期/币种：负数、逗号、Int64 边界安全解析；月起始日 29–31 在短月正确夹取；未知/混合币种不再静默按 CNY 计算。
- 数据安全：完整备份覆盖所有账本；恢复先严格校验并单事务替换，失败 rollback。
- **CSV 退款重复判定**：`PreparedRow.duplicateKey` 与已有交易 `duplicateKey(for:)` 两侧都纳入规范化 `refundOfID`，数据库已有退款时导入关联不同原交易的退款不再误判为重复；重复导入同一退款幂等跳过；相同稳定 ID 内容不同仍明确报错。
- **CSV V1/V2 由表头严格识别**：V1=10 列、V2=11 列，表头错误/缺失/重复/未知列、数据行列数不一致、无表头均明确报错；V1 退款 `id`=原支出 ID（退款自身无稳定 ID），V2 `id`=当前交易 ID + `refundOfID` 单独表达原支出；修正源码中与真实 V1 语义不一致的注释。
- **备份版本范围**：只接受 `1...currentVersion`，`version<=0`、负数、未来版本全部明确拒绝（不静默当 V1）。
- **备份回滚真正发生在部分新对象插入后**：备份回滚测试 `backupRestoreMidTransactionRollsBack` 现在使用 `RestoreFailurePoint.afterInsertedLedger(0)`，故障**在替换账本已经插入之后**才抛出（不是删除后抛错），并在当前上下文与磁盘 store 重开两个层面验证旧账本/账户/分类/交易/设置原始 ID、名称、关系完整，且不存在半写入的新对象。
- **故障注入接缝**：`importCSVWithFailure` 与 `restoreWithFailure` 均为 internal 且只被测试 Target 通过 `@testable import` 引用；故障点由字符串改为**内部枚举** `CSVImportFailurePoint` / `RestoreFailurePoint`，默认生产 API 不接受任意 failurePoint 字符串，也无编译环境变量开启故障。
- 数据安全：引入备份/CSV 事务中途故障注入测试接缝，证明「旧数据删除、新对象部分插入后抛错 → 完整 rollback」，含磁盘 store 重开验证。
- **未保存上下文**：导入/恢复前检测 `context.hasChanges`，有则返回明确错误，绝不静默 `context.save()` 提交无关改动；UI 以 toast 展示错误而非表现为成功。
- CSV：稳定交易 ID 与 `refundOfID` 分列；严格预检、单事务写入、幂等导入、跨账本隔离、旧 10 列兼容。
- 账户与交易：账户可归档；有历史流水时禁止删除；筛选补齐类型、分类、账户、日期、金额和搜索。
- 预算：显示真实分类名；未关联原交易的退款仍按所选分类抵扣；币种隔离。
- 错误处理：所有 `ModelContext.save()` 失败都显示错误并 rollback；源码中无 `try? context.save()`。
- 迁移：加入显式 `TallySchemaV1` / `TallyMigrationPlan`、旧未版本化 store 兼容测试和 `05-migration-plan.md`。
- 自动化：增加真实 SwiftData/SQLite 集成测试与 XCUITest target。

## 2. 工程内容

- App：`Tally/`，31 个 Swift 文件。
- Swift Testing：`TallyTests/`，8 个文件，**99 条测试 / 11 套件**。
- UI 自动化：`TallyUITests/`，2 条关键 XCUITest。
- 工程：`TallyLocal.xcodeproj`，包含 `Tally`、`TallyTests`、`TallyUITests` 三个 target。
- 文档：README 与 `docs/01`–`05`。

没有 SPM/CocoaPods 依赖、`.xcframework` 或第三方二进制。应用源码没有网络请求或远程 SDK；Apple 系统框架不产生第三方归属义务。

## 3. 最终实测结果

| 检查项 | 命令/环境 | 结果 |
|---|---|---|
| Debug clean build | Xcode 26.6，generic iOS Simulator，独立 derivedDataPath `/tmp/tally-closure-debug` | ✅ `BUILD SUCCEEDED` |
| Release build | Release，generic iOS Simulator，`/tmp/tally-closure-release` | ✅ `BUILD SUCCEEDED` |
| Xcode Analyze | Debug，generic iOS Simulator，`/tmp/tally-closure-analyze` | ✅ `ANALYZE SUCCEEDED` |
| Swift Testing | iPhone 17 Pro，`/tmp/tally-repair-confirm-tests` | ✅ 99/99，11 套件 |
| XCUITest | 同一模拟器 | ✅ 2/2（testOnboardingAndRecordExpenseEndToEnd、testTransactionFiltersAreReachable） |
| 非测试启动冒烟 | 安装 `/tmp/tally-closure-debug/Build/Products/Debug-iphonesimulator/Tally.app`，无 `-uiTesting`，运行 ≥10 秒 | ✅ 进程存活、无 crash/fault/error 日志（精确谓词 `process == "Tally" AND (messageType == fault OR messageType == error)`） |
| 旧 store 兼容 | 先用未版本化 Schema 写真实 SQLite，再由 V1 plan 打开 | ✅ ID 与关系保留 |
| Face ID 配置 | 检查构建产物 Info.plist | ✅ `NSFaceIDUsageDescription` 存在 |
| 依赖/网络基础检查 | 搜索 package、二进制依赖、URLSession/远程 SDK | ✅ 无第三方依赖、无网络层 |
| 编译诊断 | 检查构建/测试日志 | ✅ 无源码警告；仅 Xcode 对未使用 AppIntents 的元数据跳过提示 |

> 说明：本轮“非测试启动冒烟”只确认 App 能启动并稳定运行 ≥10 秒、无崩溃/错误日志，**不**等同于完整人工 UI 回归。生物识别系统弹窗、文件选择器等未测项继续在第五节诚实标注。

## 4. 自动化覆盖

- Money：负数、符号、逗号/分组、JPY、小数位、溢出、Int64 最小值格式化、未知币种。
- 日期：标准/自定义周期、跨年、短月与闰年 29–31 边界。
- 业务：余额、转账、退款、软删除、账户删除策略、统计币种隔离、预算分类/退款。
- 隐私首帧：settings 未加载→loading、未完成引导→onboarding、生物锁+锁定→locked、认证失败仍锁、认证成功/关生物锁→main、后台重锁、nil→需要锁定中间不经过 main、**重新启用立即锁定（false→true）、重新启用后认证失败仍 locked、重新启用后认证成功回 main、关闭后可再开启仍锁定、快速切换 ON→OFF / ON→OFF→ON 时过期认证结果被丢弃（确定性异步测试）**。
- SwiftData：重启持久化、旧 store 兼容、完整多账本恢复、坏备份不改原库、**备份事务中途故障 rollback（故障点在新账本已插入之后触发，当前上下文 + 磁盘 store 重开双验证：原始 ID/名称/关系完整、无半写入新对象）**、**CSV 磁盘级中途失败 rollback（真实磁盘 store，原数据保留、半写对象不存在、重开同一 store 复核）**、**未保存上下文不被静默提交**。
- CSV：V1/V2 由表头严格识别、BOM、引号/逗号/换行字段、无表头拒绝、非法表头拒绝、行列数不一致拒绝、V1/V2 不互相误判、**退款 duplicate key 含 refundOfID（不同原交易不误判重复、重复导入幂等、同 ID 冲突报错）**、V2 未关联退款、ID/退款往返、跨账本 ID/分类隔离、错误文件零半写、**CSV 事务中途故障 rollback（内存 + 磁盘双覆盖）**、币种拒绝、同 ID 冲突内容显式报错。
- 备份版本：未来、0、负数、唯一受支持范围。
- UI：首次引导→记 12.50 支出→首页汇总；进入明细并打开日期/金额等筛选。

## 5. 尚未完成/不能宣称通过

- 未做真机、Archive、签名、App Store 上传与审核。
- AppIcon 只有空的 1024×1024 槽位，没有正式位图。
- 未做万级交易性能基准、内存/能耗 Instruments 或长时间稳定性测试。
- Dynamic Type/VoiceOver 有基础实现，但尚未完成人工全流程审计；iPad 独立布局未设计。
- 仅简体中文；没有繁体/英文。
- CloudKit、周期交易、模板、小组件、Siri、本地通知不在本轮范围。
- XCUITest 覆盖关键路径，不代表编辑、预算、文件选择器、生物识别系统弹窗已做完整 UI 回归。

## 6. 上架前阻断项

- [ ] 设计并加入正式 AppIcon，生成商店截图与隐私政策网页。
- [ ] 真机 Debug/Release、Archive 和 TestFlight 冒烟。
- [ ] 5–8 位目标用户可用性测试，记录首笔完成率与耗时。
- [ ] 万级交易数据性能、内存、能耗和导入/恢复压力测试。
- [ ] VoiceOver、最大 Dynamic Type、对比度和点击区域人工审计。
- [ ] 用最后一个已发布 build 生成迁移 fixture，并执行 `05-migration-plan.md` 的升级矩阵。
- [ ] 对 CSV/JSON 文件做 fuzz 与大文件限制策略；评估备份文件加密提示。

## 7. 本轮明确不决策

旧服务端数据迁移、CloudKit、收费模式和发布不属于本轮可靠性加固；这些仍需单独产品决策与授权。
