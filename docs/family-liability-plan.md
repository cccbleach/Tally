# ⚠️ 历史文档（已被取代）

> 本文件是共享账本 / 负债功能的设计过程记录，部分接口与现状不符：
> `POST /families/:id/members` 直接加人已下线（410 `FAMILY_FLOW_REMOVED`，改为按昵称邀请）、
> 账本切换实为 `POST /ledgers/switch`（`{ledgerId}`）、`GET /transactions/duplicates` 不存在。
> **当前口径以 docs/api.md 与 docs/openapi.yaml 为准**，不要把本文当实施依据。

# Tally 家庭 / 去重 / 负债 优化计划

> 目标：支持“家庭成员 + 家庭共享账本”的记账模式；解决多来源账单（微信/支付宝/银行）重复入账；
> 补齐车贷、房贷、信用卡等负债账户的建模与统计。
> 本文是路线图，实际实施按阶段推进，每阶段有独立验收标准。

---

## 一、现状基线（代码里已具备的）

- 用户（user）→ 账本（ledger）→ 账户/分类/流水/预算/周期账单
- 每用户一个默认账本；所有模块按 `user_id + ledger_id` 隔离
- 账单导入已有：`external_id` 去重、微信 xlsx / 支付宝 csv / 银行 PDF 解析
- 信用卡已有基础负债语义：`isLiability`、`debt`、`totalAssets/totalDebt`
- 多币种已有 `exchange_rates` 换算

## 二、总体架构演进方向

```
用户(成员)  --成员关系-->  家庭(family)
家庭  --拥有/共享-->  共享账本(family ledger)
账本  --包含-->  账户/分类/流水/预算/周期账单/贷款/信用卡

去重：流水增加 来源源 + dedup_key + 关联合并
负债：贷款/信用卡作为独立实体，参与资产负债统计
```

---

## 阶段 A：家庭与成员（P0）

### A.1 数据模型
- 新增 `families`
  - `id, name, owner_user_id, created_at, updated_at`
- 新增 `family_members`
  - `id, family_id, user_id, role(owner|admin|member), is_active, joined_at`
  - 唯一：`(family_id, user_id)`
- 扩展 `ledgers`
  - `family_id TEXT NULL`（NULL = 个人账本；非 NULL = 家庭共享账本）
  - 保留 `user_id` 作为创建者/管理者
- 迁移兼容：老用户的默认账本仍为个人账本

### A.2 访问控制（核心）
- 新增 `family_access` 规则：
  - 个人账本：仅创建者可读写
  - 家庭账本：该家庭所有 `is_active` 成员可读写；`owner/admin` 可管理成员
- 后端统一加一个 `getAccessibleLedger(db, userId, ledgerId?)` 帮助函数：
  - 不传 `ledgerId`：返回“当前账本”（个人默认或当前家庭账本）
  - 传 `ledgerId`：校验用户是否有权访问，无权限返回 403
- 所有模块查询从“固定 getLedgerId(userId)”改为“解析可选 ledgerId + 权限校验”

### A.3 API
- 家庭
  - `POST /api/v1/families` 创建家庭
  - `GET /api/v1/families` 我加入的家庭
  - `GET /api/v1/families/:id` 家庭详情 + 成员
  - `POST /api/v1/families/:id/members` 邀请/添加成员（按手机号/账号）
  - `DELETE /api/v1/families/:id/members/:userId` 移除成员
  - `PATCH /api/v1/families/:id` 改名/改角色
- 账本
  - `POST /api/v1/ledgers` 创建个人/家庭账本
  - `GET /api/v1/ledgers` 我可见的账本
  - `POST /api/v1/ledgers/:id/switch` 切换当前账本（会话级，iOS 保存）
- 统计
  - `GET /api/v1/stats/summary?ledgerId=` 支持按账本（家庭）统计
  - 首页/报表增加“按家庭”维度

### A.4 iOS
- 新增“家庭”Tab 或设置入口：
  - 创建/加入家庭、邀请成员
  - 当前家庭/账本切换器
- 明细、统计、预算都随当前账本切换
- 账户/分类/流水页面显示所属账本/家庭标识

### A.5 验收
- 两个账号 A/B 加入同一家庭后，A 记的流水 B 能看到
- 家庭账本的统计只统计该家庭账本内数据
- 个人账本彼此不可见
- 移除成员后立即无访问权限

---

## 阶段 B：多来源去重与关联（P0）

### 问题定义
- 同一笔真实支出可能同时出现在：
  - 微信/支付宝账单（记为“支出”，但实际扣的是银行卡）
  - 银行卡流水（也记了一笔支出）
- 当前只按各自 `external_id` 去重，跨来源会重复入账

### B.1 数据模型扩展
- `transactions` 增加：
  - `source_type TEXT`（manual/wechat/alipay/bank/loan/credit_card）
  - `source_ref TEXT`（来源流水号，保留 external_id 的别名）
  - `dedup_key TEXT`（规范化后的跨来源指纹）
  - `linked_transaction_id TEXT NULL`（人工确认合并的目标流水）
- 唯一索引：
  - `(user_id, source_type, source_ref)` 保留来源内幂等
  - `(ledger_id, dedup_key)` 用于跨来源去重（dedup_key 非 NULL 时）

### B.2 dedup_key 生成规则（导入时计算）
- 归一化：日期（±1 天内）、金额（绝对值、分）、币种
- 商家/备注清洗：
  - 去掉“微信转账/支付宝/银联/快捷支付/（特约）”等平台前缀
  - 去掉空格、全半角、括号内容差异
  - 保留数字/字母/中文核心词
- 生成：`sha1(date|amount|currency|normalizedMerchant)`
- 银行卡流水是“事实来源”，微信/支付宝可作为“消费渠道说明”

### B.3 导入策略（默认安全）
- 首次导入：按 `dedup_key` 检查
  - 无匹配 → 新增
  - 有匹配（同一账本）→ 默认**跳过**，并返回 `suspectedDuplicates` 列表
- 用户可在导入结果页选择：
  - “跳过”（默认）
  - “仍然新增”（如确实两笔）
  - “合并/关联”（把新流水挂到已有流水，或新增但标记关联）
- 新增接口：
  - `POST /api/v1/transactions/import` 返回 `{imported, skipped, suspectedDuplicates}`
  - `POST /api/v1/transactions/link` `{sourceId, targetId}`
  - `GET /api/v1/transactions/duplicates?ledgerId=` 疑似重复列表

### B.4 手动去重 UI
- iOS 流水列表增加“疑似重复”入口
- 展示两笔流水，用户选择“保留一笔/合并/确认为两笔”

### B.5 验收
- 同一银行卡流水分别从“微信导入”和“银行 PDF”导入后，不重复入账
- 导入结果能提示疑似重复
- 用户可手动合并/确认

---

## 阶段 C：车贷 / 房贷 / 信用卡（P1）

### C.1 贷款（车贷/房贷）
- 新增 `loans`
  - `id, user_id, ledger_id, name, type(car|mortgage|other)`
  - `principal, annual_rate, term_months, start_date, monthly_payment`
  - `account_id`（还款扣款账户）
  - `next_payment_date, remaining_principal`
- 新增 `loan_payments`
  - `id, loan_id, scheduled_date, principal_part, interest_part, total, paid`
  - 由导入或周期账单联动生成
- 提供等额本息/等额本金计算器：
  - `lib/loan.ts`：`amortizationSchedule(principal, rate, months, type)`
  - 每月自动生成还款流水（可接入 recurring）
- 统计：负债 = 贷款剩余本金 + 信用卡欠款

### C.2 信用卡增强
- `accounts`（type=credit）扩展：
  - `credit_limit`, `billing_day`, `repayment_day`, `statement_balance`
- 新增 `credit_card_bills`
  - `id, account_id, period, statement_balance, minimum_payment, due_date, paid`
- 还款建议：`due_date` 前提醒；还款 = 从储蓄卡转账到信用卡账户

### C.3 资产负债统计
- `assetDebtSummary` 扩展为：
  - 资产：现金/存款/理财等正资产
  - 负债：信用卡欠款 + 贷款剩余本金
  - 净资产 = 资产 − 负债
- 新增接口 `GET /api/v1/liabilities`：列出所有负债（信用卡/贷款）与还款计划

### C.4 iOS
- 账户页支持“贷款账户/信用卡”详情
- 新增“负债中心”：信用卡账单、车贷/房贷还款计划、下期应还
- 首页净资产 = 总资产 − 总负债

### C.5 验收
- 能创建车贷/房贷并自动生成等额本息还款计划
- 还款流水自动扣减贷款剩余本金
- 信用卡账单/额度/还款日可维护
- 净资产正确包含贷款与信用卡欠款

---

## 阶段 D：跨阶段工程保障

### D.1 迁移策略
- 所有 schema 变更使用新迁移文件（`0007+`），不修改已发布迁移
- 老数据平滑迁移：
  - 默认家庭：不强制；用户创建家庭时才生成
  - 老账本保持个人账本
  - 老流水 `source_type='manual'`、`dedup_key=NULL`

### D.2 权限与安全
- 家庭成员接口需要鉴权 + 角色校验
- 禁止通过 `ledgerId` 越权访问他人账本（统一 `getAccessibleLedger`）
- 邀请成员使用手机号/账号，需对方确认（可先用“邀请即加入”简化）

### D.3 测试
- 后端：
  - 家庭共享/隔离集成测试
  - 去重指纹单元测试（微信 vs 银行样例）
  - 贷款摊销单测
  - 权限越权测试（403）
- iOS：`xcodebuild` + 关键流程人工回归

### D.4 文档
- `docs/api.md` 增加家庭/账本/负债接口
- `docs/deploy.md` 更新权限与数据说明

---

## 实施顺序与工作量预估

| 阶段 | 内容 | 优先级 | 相对工作量 |
|---|---|---|---|
| A | 家庭 + 成员 + 共享账本 | P0 | 大（涉及全部模块权限） |
| B | 多来源去重 + 合并 | P0 | 中-大 |
| C | 车贷/房贷/信用卡负债 | P1 | 大 |
| D | 迁移/权限/测试/文档 | 贯穿 | 中 |

建议顺序：**A → B → C**，每阶段先出后端 API + 测试，再 iOS，最后文档。

---

## 关键设计决策（建议先确认）

1. **家庭是否允许多个家庭**：建议“一个用户可以加入多个家庭，但同一时刻只有一个‘当前家庭’”，iOS 有切换器。
2. **家庭账本是否独立于个人账本**：建议家庭使用独立共享账本，不合并个人历史数据，避免隐私混乱。
3. **去重匹配强度**：建议默认“金额+日期±1天+规范化商家”强匹配；弱匹配只提示不自动跳过。
4. **贷款扣款方式**：建议用“还款流水 + 自动更新剩余本金”，不直接改贷款余额表，保留审计。

---

## 实施状态（Round 9）

- ✅ 阶段 A：家庭/成员/共享账本（后端全部 + iOS 基础）
- ✅ 阶段 B：跨来源去重（dedup_key、疑似重复、force 强制保留、link 关联）
- ✅ 阶段 C：贷款/信用卡/负债（后端 + iOS 负债中心/账单管理）
- ✅ 文档同步：`docs/api.md` 已补充家庭/账本/贷款/负债/去重说明
- ⏸ 可选后续：家庭邀请链接、信用卡账单新建表单、iOS 去重合并交互增强
