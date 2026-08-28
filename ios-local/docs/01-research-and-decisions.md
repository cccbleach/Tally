# Tally（本地优先版）— 调研与构建决策

> 范围：`ios-local/` 原生 iOS 应用。复核日期：2026-08-25。
> 本文把产品自述、商店信息和代码仓库事实与我们的判断分开；评分与差异化属于项目判断，不冒充用户研究结论。

## 1. 仓库边界

仓库另有 `ios/` + `backend/` 的账号/服务端方案，与“无账号、核心功能完全离线、财务数据默认不上传”的方向冲突。因此本地优先版继续独立放在 `ios-local/`；本轮没有修改旧客户端、后端或做数据迁移。以后若决定合并，应另立迁移项目，不能直接删除旧数据。

## 2. 用户与核心任务假设

目标用户是希望低成本记录日常收支、又不愿先注册或上传财务明细的个人用户。核心任务按优先级为：

1. 首次启动无需注册，立即可记一笔。
2. 离线完成支出、收入、转账、退款及修改删除。
3. 查看可信的余额、月度统计和预算。
4. 搜索旧账，并能完整备份、恢复或导出。

这些是产品假设，不等于已完成访谈验证。正式商业化前仍应做 5–8 位目标用户的可用性测试，并量化首笔记账完成率、单笔耗时、7 日留存和备份成功率。

## 3. 实时竞品复核

| 产品 | 官方页面可核实能力 | 账号/同步与收费 | 对 Tally 的启示 |
|---|---|---|---|
| [钱迹](https://apps.apple.com/cn/app/id1473785373) | 快捷记账、账户/分类、多账本、预算、搜索、导入导出、退款、多币种、小组件 | 免费 + 内购；产品页说明数据可随账号同步 | 功能深度远超 MVP；Tally 不应宣传“功能更多”，应守住无账号、无云依赖和可验证导入恢复 |
| [鲨鱼记账](https://apps.apple.com/cn/app/id1079718756) | 3 秒记账、趋势、提醒、小组件 | 产品页明确登录后云同步，并列出 VIP 订阅 | “快速录入”是基础门槛，不足以单独构成差异化 |
| [Dime](https://apps.apple.com/us/app/id1635280255) | 预算、周期交易、iCloud、提醒、生物识别、小组件、深色模式 | 免费 + 内购；iCloud 同步 | 本地体验和原生设计已有成熟对手；Tally 的恢复原子性、退款往返和中文场景必须做实 |
| [MoneyWiz](https://apps.apple.com/us/app/id1511185140) | 银行连接、手工账户、退款/转账识别、多币种、预算、报表、多格式导入 | 免费 + 订阅；云备份/多设备同步 | 专业财务全能路线成本极高，MVP 明确不做银行、投资和汇率系统 |

商店评论只能作为线索，不能据少量可见评论声称“高频抱怨”。目前能直接看到的正向线索包括钱迹用户对无广告、简洁和买断的偏好；负向问题需要后续按固定样本与编码规则采集，本文不下统计结论。

## 4. 开源候选复核

| 项目 | 技术/功能 | 许可证与活跃信号 | 采用结论 |
|---|---|---|---|
| [rafsoh/dimeApp](https://github.com/rafsoh/dimeApp) | SwiftUI 个人财务、预算、iCloud、生物识别、小组件；仓库列出多项第三方依赖 | GPL-3.0；复核时约 1.9k stars / 265 forks | 不复制或 Fork：GPL 传播义务、依赖面和 CloudKit 路线不符合当前边界；仅作交互参考 |
| [michaeldiestelberg/maeuse-ios](https://github.com/michaeldiestelberg/maeuse-ios) | SwiftUI + SwiftData，本地优先，JSON 备份；重点是情侣分账 | MIT；仓库标注 App Store v1.3.0/build 32 | 许可证友好，备份/发布流程值得参考；领域模型是共享分账，不直接复用 |
| [DMLayMan/Ledgerly](https://github.com/DMLayMan/Ledgerly) | SwiftUI + Core Data/CloudKit，预算、共享账本 | MIT；复核时 1 star、0 fork、无 release 信号 | 方向接近但维护证据弱且存储栈不同，不作为基座 |
| [janishahn/expenses](https://github.com/janishahn/expenses) | React/FastAPI + SwiftUI，自托管后端 | PolyForm Noncommercial 1.0.0；明确不允许商业使用 | 许可证与无后端目标都不匹配，排除 |

没有任何候选在“SwiftData、本地单机、中文个人账本、支出/收入/转账/退款、严格 CSV/JSON 往返、无第三方依赖”上直接满足本项目。当前代码因此继续自研，不复制第三方源码，也没有第三方许可证归属项。

## 5. 构建方式评分（1–5）

| 维度 | 直接采用 | Fork | 组合组件 | 从零自研 |
|---|---:|---:|---:|---:|
| 需求匹配 | 2 | 3 | 3 | 5 |
| 许可证可控 | 2 | 3 | 4 | 5 |
| 隐私/离线边界 | 3 | 3 | 4 | 5 |
| 迁移与数据口径可控 | 2 | 3 | 4 | 5 |
| 首次交付速度 | 4 | 3 | 3 | 3 |
| 长期维护 | 2 | 3 | 4 | 4 |

结论：继续从零自研，使用 Apple 原生框架。可借鉴 Mäuse 的本地备份/发布清单和 Dime 的原生交互，但不引入其代码。

## 6. MVP 优先级依据

- Must Have：无账号引导、四种交易、账户/分类、搜索与完整筛选、可信统计/预算、本地持久化、软删除、CSV 与完整备份恢复、隐私锁。依据是四条核心任务，缺一会中断端到端流程或削弱数据可信度。
- Should Have：周期交易、模板、小组件、自动备份、本地通知、本地化。竞品已验证其价值，但不影响首个离线闭环。
- Could Have：Watch、Siri、OCR、共享账本、高级报表。
- Won’t Have Now：CloudKit、银行连接、投资/汇率、广告与远程分析。它们会显著扩大隐私、合规和迁移范围。

## 7. 官方技术依据

- Apple 的 [Face ID / Touch ID 指南](https://developer.apple.com/documentation/localauthentication/logging-a-user-into-your-app-with-face-id-or-touch-id) 是隐私锁与 `NSFaceIDUsageDescription` 的依据。
- SwiftData 写入、事务与回滚以 Apple 的 [ModelContext](https://developer.apple.com/documentation/swiftdata/modelcontext) 文档为准。
- 模型演进采用显式 [SchemaMigrationPlan](https://developer.apple.com/documentation/swiftdata/schemamigrationplan)，详见 `05-migration-plan.md`。

## 8. 仍需验证的产品风险

- “本地不登录”是否足以提升留存，尚无本项目用户数据。
- 快记流程已由 XCUITest 验证可完成，但真实用户能否稳定在目标时间内完成，需可用性测试。
- 无云同步降低隐私风险，也提高换机丢失风险；必须把备份引导与恢复成功率作为正式版指标。
