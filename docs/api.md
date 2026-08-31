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

## 认证（手机号 + 唯一昵称身份）

- 手机号仅用于验证码登录，限定中国大陆 11 位，统一存为 `+86` E.164（`138…` / `+86138…` 等同账号）。
- 昵称是公开账号身份，用于家庭邀请与成员展示；手机号不向其他用户公开（仅本人接口返回）。
- 邮箱/密码登录、找回密码已彻底下线：旧接口保留路由但统一返回 `410 AUTH_METHOD_REMOVED`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /auth/request-code | 请求登录验证码，入参 `{phone}`。生产环境短信真实投递只返回 `{ok:true}`；开发模式回传 `{ok, code}` |
| POST | /auth/login-code | 验证码登录，入参 `{phone, code}`。返回判别联合：`{status:"authenticated", user, token, refreshToken}`（完整账号）或 `{status:"nickname_required", onboardingToken, expiresAt}`（新账号/旧“用户”账号，需先完成强制昵称设置） |
| POST | /auth/complete-profile | 完成强制昵称设置，入参 `{onboardingToken, nickname}`。onboarding 令牌 10 分钟、一次性；成功后创建/恢复会话并确保默认账本与分类 |
| POST | /auth/refresh | 刷新，入参 `{refreshToken}`，返回 `{token, refreshToken}` |
| GET | /auth/me | 当前用户，返回 `{user}`（含本人手机号） |
| GET | /users/me | 本人资料，返回 `{user}`（含脱敏手机号 `phoneMasked`） |
| GET | /users/nickname-availability?nickname= | 昵称可用性，返回 `{available, reason?}` |
| PATCH | /users/me/nickname | 修改昵称，入参 `{nickname}`（30 天冷却 + 全局判重 + 旧昵称 30 天内不可被他人占用，到期后释放） |
| POST | /auth/register | **旧邮箱注册（已下线）→ 410 AUTH_METHOD_REMOVED** |
| POST | /auth/login | **旧密码登录（已下线）→ 410 AUTH_METHOD_REMOVED** |
| POST | /auth/reset-code | **旧找回密码验证码（已下线）→ 410 AUTH_METHOD_REMOVED** |
| POST | /auth/reset-password | **旧密码重置（已下线）→ 410 AUTH_METHOD_REMOVED** |

`User` 类型：`{ id, phone, nickname, nicknameChangeAvailableAt, createdAt }`。
`id` 为内部不可变 UUID（JWT subject / 关联 / 审计）；手机号与昵称是两个全局唯一的业务身份。

### 昵称规则

- 2–20 个中文、Unicode 字母、数字或下划线；禁止空格、emoji、纯数字。
- NFKC + 大小写不敏感判重（`Abc` 与 `abc` 冲突）。
- 保留系统词：`tally/admin/system/官方/管理员/系统/用户`。
- 每人每 30 天最多改名一次；旧昵称 30 天内不可被他人占用，到期后释放。

### 登录与强制昵称

- 输入手机号 → 验证码：已有完整账号直接登录；新账号或旧“用户”账号进入强制昵称设置页。
- 完成昵称需要一次性 onboarding ticket（只存哈希、10 分钟过期、仅可使用一次；完成昵称后才创建/恢复会话）。

### 冲突错误

- `PHONE_EXISTS` / `NICKNAME_TAKEN` / `NICKNAME_CHANGE_COOLDOWN` / `ALREADY_IN_FAMILY` / `INVITATION_EXISTS` / `INVALID_ONBOARDING_TOKEN`。

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
