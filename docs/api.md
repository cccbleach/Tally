# Tally 后端 API 契约

- 基础路径：`/api/v1`
- 请求/响应均为 JSON，字符编码 UTF-8
- 除 `/auth/register`、`/auth/login`、`/health` 外，均需在请求头携带 `Authorization: Bearer <token>`
- **金额一律为整数「分」**（如 12.34 元 = `1234`），避免浮点误差；客户端负责按币种本地化展示
- 日期（流水 `date`、周期 `startDate/endDate/nextRunDate`）为 `YYYY-MM-DD` 字符串；时间戳（`createdAt/updatedAt`）为 ISO 8601 字符串
- 错误统一返回 `{ "error": { "code": "...", "message": "..." } }`

## 多端同步与冲突策略

- **当前策略：Last-Write-Wins + 乐观锁**。服务端以 `updatedAt` 为版本号，写接口返回最新的 `updatedAt`。
- PATCH 写接口可携带可选参数 `expectedUpdatedAt`（ISO 8601）；若其与服务端当前 `updatedAt` 不一致，返回 `409 { error: { code: "CONFLICT" } }`，客户端应刷新后再提交。
- 目前 `expectedUpdatedAt` 支持：流水、预算、周期账单。账户/分类暂无 `updatedAt`，采用“提交后整体刷新”策略。
- 客户端多端同步建议：拉取 → 记录 `updatedAt` → 修改时带上 → 遇 409 提示冲突并拉取最新。
- 服务端不提供合并/三方合并；冲突由客户端引导用户处理（或按策略直接覆盖）。

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /auth/register | 注册，入参 `{account, password(≥8), displayName?}`，账号可为邮箱或手机号；成功自动播种默认分类，返回 `{user, token, refreshToken}`（字段名兼容保留为 `email`） |
| POST | /auth/login | 登录，入参 `{account, password}`，账号可为邮箱或手机号；返回 `{user, token, refreshToken}`（字段名兼容保留为 `email`） |
| POST | /auth/refresh | 刷新，入参 `{refreshToken}`，返回 `{token, refreshToken}` |
| POST | /auth/request-code | 请求验证码，入参 `{account}`（手机号）。已配置阿里云短信时发送短信并返回 `{ok}`；未配置时返回 `{ok, code}`（开发/降级模式） |
| POST | /auth/login-code | 验证码登录，入参 `{account, code}`；未注册的手机号自动注册并投产默认分类，返回 `{user, token, refreshToken}` |
| GET | /auth/me | 当前用户，返回 `{user}` |

- `token` 为短期访问令牌（HS256，默认 15 分钟）；`refreshToken` 为刷新令牌（默认 30 天）。
- 访问令牌过期后，客户端用 `refreshToken` 调用 /auth/refresh 换新；刷新令牌不能用作访问令牌（受保护接口返回 401）。
- 验证码为 6 位、5 分钟有效、最多错 3 次；未配置短信服务时直接回传 `code`（开发模式），配置阿里云短信后发送短信并仅返回 `{ok:true}`。
- 验证码登录未注册时自动创建账号（密码置空），可后续通过忘记密码设置密码。

## 账户 Accounts

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /accounts | 列表，返回 `{items:[...]}`，每项含实时 `balance` |
| POST | /accounts | 新建，入参 `{name, type, currency?, initialBalance?, icon?, color?}` |
| GET | /accounts/:id | 详情 |
| PATCH | /accounts/:id | 更新（name/type/currency/initialBalance/icon/color/isArchived） |
| DELETE | /accounts/:id | **软删除（归档）**，保留流水关联 |

- `type` 取值：`cash | bank | e-wallet | credit | other`
- 账户余额 = 初始余额 + 收入 − 支出 + 转入 − 转出（账户本位币口径）
- 信用卡（`credit`）为负债账户：返回 `isLiability=true`，`debt` 为当前未结清欠款（本币正数），`balance` 保持净值口径（欠款为负）

## 分类 Categories

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /categories | 列表，按 sortOrder 排序，返回 `{items}` |
| POST | /categories | 新建 `{name, type, icon?, color?, sortOrder?}` |
| PATCH | /categories/:id | 更新（name/icon/color/sortOrder；不支持改 type） |
| DELETE | /categories/:id | 删除（关联流水 categoryId 置空） |

- `type` 取值：`income | expense`
- 注册时自动播种默认分类：餐饮/交通/购物/居住/娱乐/医疗/教育/人情/其他支出/工资/理财/其他收入

## 流水 Transactions

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /transactions | 列表，查询参数 `from/to/accountId/categoryId/type/page/limit`，返回 `{items,total,page,limit}` |
| POST | /transactions | 新建（见下） |
| GET | /transactions/:id | 详情 |
| PATCH | /transactions/:id | 更新 `{amount?, date?, note?, accountId?, categoryId?, expectedUpdatedAt?}`（支持乐观锁） |
| DELETE | /transactions/:id | 删除 |
| POST | /transactions/import | 账单导入，见下 |

**账单导入（微信/支付宝等）**
- 方式一（原始文件，推荐客户端上传）：
  `{mode:"raw", source:"wechat"|"alipay"|"bank", content:"<文本内容>" 或 contentBase64:"<文件base64>"}`
  - 微信：支持 txt / xlsx（自动识别）；支付宝：csv；银行：pdf / csv（当前按招商银行等常见“日期 币种 金额 余额 摘要”格式）
  - 后端自动识别 UTF-8 / GBK 编码
- 方式二（客户端已解析）：
  `{mode:"items", items:[{date, amount, type, note?, externalId?}]}`
- 返回 `{imported, skipped, total}`；按 `(user_id, external_id)` 唯一去重，重复导入自动跳过。
- 导入流水的账户/分类取当前账本默认（首个非归档账户 + 匹配收支类型的分类），后续可扩展为逐条指定。

新建入参按 `type` 区分：

- 支出/收入：`{type:"income"|"expense", amount, date, accountId, categoryId, note?, currency?}`
- 转账：`{type:"transfer", amount, date, accountId, transferToAccountId, note?, currency?}`

校验：分类类型必须与收支类型匹配；转账源/目标账户不能相同；转账不计入收入/支出汇总。
`GET /transactions?accountId=` 会同时匹配转出与转入账户，保证任一账户都能检索到相关转账流水。

## 预算 Budgets

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /budgets?year&month | 列表（默认当月），返回 `{year,month,items}`，每项含 `spent/percent` |
| POST | /budgets | upsert `{year, month, categoryId?, amount}`；`categoryId` 为空表示总预算 |
| PATCH | /budgets/:id | 更新金额 `{amount, expectedUpdatedAt?}`（支持乐观锁） |
| DELETE | /budgets/:id | 删除 |
| GET | /budgets/overview?year&month | 汇总 `{totalBudget,totalSpent,totalPercent,items}` |

- POST 与 PATCH 均返回与列表一致的预算项（含 `spent/percent`），保证客户端契约一致。
- 预算仅针对支出；`percent` 为已用百分比（0-100，可超过 100 表示超支）。

## 周期账单 Recurring

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /recurring | 列表 |
| POST | /recurring | 新建 `{accountId, categoryId, type, amount, frequency, interval?, startDate, endDate?, note?}` |
| PATCH | /recurring/:id | 更新（含 isActive 启停；改 startDate 重置 nextRunDate；支持 expectedUpdatedAt 乐观锁） |
| DELETE | /recurring/:id | 删除 |

- `frequency` 取值：`daily | weekly | monthly | yearly`；`interval` 为间隔期数（≥1）
- 到期自动生成流水：仅在服务启动时与每日 00:05 定时补跑（GET 接口不再写入）。
- 幂等由数据层保证：每条生成的流水记录 `recurring_id` 并以 `(recurring_id, date)` 唯一约束兜底，重复补跑/崩溃恢复不会重复入账。

## 统计 Stats

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /stats/summary?year&month | `{income, expense, net, balance, totalAssets, totalDebt, byCategory, byAccount, daily}` |
| GET | /stats/trend?months=6 | `{months:[{year,month,income,expense}]}` |

- `net = income - expense`；`balance` 为各账户余额按汇率折算到基准币种（默认 CNY）后的净值总和。
- `totalAssets` 为不含负债的资产；`totalDebt` 为信用卡等负债账户的未结清欠款；`balance = totalAssets - totalDebt`（兼容字段，保持净值口径）。
- 账户级 `balance`（见账户接口）以该账户本位币计价；跨账户的 `income/expense/net/balance/byCategory/byAccount/daily` 均按汇率折算到基准币种，不再直接相加。
- 汇率：优先用户级 → 全局 → 内置兜底；未知币种按 1:1 兜底。内置常见币种（USD/EUR/GBP/JPY/HKD/KRW/SGD/AUD/CAD）为人民币视角的近似参考值。
- `byCategory`/ 为支出按分类汇总（含占比 `percent`）；`byAccount` 为支出按账户汇总；`daily` 为当月每日收入/支出。

## 家庭 / 账本（共享）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /families | 创建家庭，自动创建家庭共享账本并切换为当前 |
| GET | /families | 我加入的家庭列表 |
| GET | /families/:id | 家庭详情（成员 + 账本） |
| POST | /families/:id/members | 添加成员 `{userId}` |
| PATCH | /families/:id | 修改家庭名称 |
| DELETE | /families/:id/members/:memberUserId | 移除成员 |
| GET | /ledgers | 我可见的账本（个人 + 家庭） |
| POST | /ledgers/switch | 切换当前账本 `{ledgerId}` |

- 账户/分类/流水/预算/周期账单/统计等接口支持 `ledgerId`（query 或 body），用于指定家庭共享账本
- 访问控制：个人账本仅创建者；家庭账本仅活跃成员；越权返回 403

## 贷款 / 负债

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /loans | 创建贷款（车贷/房贷/其他），自动生成等额本息还款计划 |
| GET | /loans | 当前账本贷款列表 |
| GET | /loans/:id | 贷款详情 + 还款计划 |
| PATCH | /loans/:id | 更新贷款（名称/利率/扣款账户） |
| DELETE | /loans/:id | 删除贷款 |
| POST | /loans/:id/pay | 标记一期已还，自动更新剩余本金 |
| GET | /liabilities | 负债总览（信用卡欠款 + 贷款剩余 + 信用卡账单） |
| POST | /credit-cards/:accountId/bills | 创建信用卡账单 |
| GET | /credit-card-bills | 当前账本信用卡账单列表 |
| PATCH | /credit-card-bills/:id | 标记账单已还 `{paid}` |

- 净资产 = 资产 −（信用卡欠款 + 贷款剩余本金）
- 账户接口的信用卡支持 `creditLimit/billingDay/repaymentDay`

## 账单导入去重

- 导入时生成跨来源指纹 `dedup_key`（日期+金额+币种+规范化商家）
- 默认遇到同账本相同指纹自动跳过，并返回 `suspectedDuplicates`
- `force:true` 可强制新增重复项（清空 `dedup_key` 并记录 `linked_transaction_id`）
- `POST /transactions/link` 可手动将疑似重复流水关联到已有流水

## 健康检查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /health | 返回 `{status:"ok", time}` |
