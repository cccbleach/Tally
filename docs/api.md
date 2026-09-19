# Tally 后端 API 契约

- 基础路径：`/api/v1`
- 请求/响应均为 JSON，字符编码 UTF-8
- **免鉴权端点**（其余全部需要 `Authorization: Bearer <token>`）：
  `/health`、`/health/live`、`/health/ready`、`/auth/request-code`、`/auth/login-code`、
  `/auth/complete-profile`、`/auth/refresh`、`/users/nickname-availability`。
  注意 `/auth/register`、`/auth/login`、`/auth/reset-code`、`/auth/reset-password` 已下线（统一 410 `AUTH_METHOD_REMOVED`），不要再调用。
- **服务端登出**：`POST /auth/logout`（携带 `{refreshToken}` 吊销当前设备会话，幂等）、
  `POST /auth/logout-all`（吊销该用户全部会话）。登出后该 refresh token 立即失效；
  access token 为无状态 JWT，在其 15 分钟有效期内仍可用。
- 认证接口限流命中时返回 `429`，并带 `Retry-After` 头。短信相关错误码：
  `SMS_COOLDOWN`（同号码冷却中）、`SMS_DAILY_LIMIT`（该号码当日配额用尽）、
  `SMS_GLOBAL_DAILY_LIMIT`（全局日预算用尽）、`RATE_LIMITED`（IP/号码分钟级限流）。
- **金额一律为整数「分」**（如 12.34 元 = `1234`），避免浮点误差；全站人民币单币种（多币种与汇率已下线）
- 日期（流水 `date`、周期 `startDate/endDate/nextRunDate`）为 `YYYY-MM-DD` 字符串；时间戳（`createdAt/updatedAt`）为 ISO 8601 字符串
- 错误统一返回 `{ "error": { "code": "...", "message": "..." } }`

## 多端同步与冲突策略

- **当前策略：Last-Write-Wins + 乐观锁**。服务端以 `updatedAt` 为版本号，写接口返回最新的 `updatedAt`。
- PATCH 写接口可携带可选参数 `expectedUpdatedAt`（ISO 8601）；若其与服务端当前 `updatedAt` 不一致，返回 `409 { error: { code: "CONFLICT" } }`，客户端应刷新后再提交。
- `expectedUpdatedAt` 支持：流水、周期账单、**分类**（分类自 0023 迁移起携带 `updatedAt`，每次成功 PATCH 前移）。
- `POST /transactions` 支持可选 `clientRequestId`（8–64 位字母数字/连字符）：离线写队列重放与网络重发的幂等键，同键重复提交返回首次创建的流水（并发窗口由 `(ledger_id, client_request_id)` 唯一索引兜底）。
- 客户端多端同步建议：拉取 → 记录 `updatedAt` → 修改时带上 → 遇 409 提示冲突并拉取最新。
- 服务端不提供合并/三方合并；冲突由客户端引导用户处理（或按策略直接覆盖）。

## 认证（手机号 + 唯一昵称身份）

- 手机号仅用于验证码登录，限定中国大陆 11 位，统一存为 `+86` E.164（`138…` / `+86138…` 等同账号）。
- 昵称是公开账号身份，用于共享账本邀请与成员展示；手机号不向其他用户公开（仅本人接口返回）。
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

- `NICKNAME_TAKEN` / `NICKNAME_CHANGE_COOLDOWN` / `ALREADY_IN_FAMILY` / `INVITATION_EXISTS` / `INVALID_ONBOARDING_TOKEN`。

### 其他常见错误码（写路径护栏）

| 错误码 | 场景 |
|---|---|
| `INVALID_YEAR` / `INVALID_MONTH` | `year`/`month` 查询参数越界（如 `month=13`），不再静默返回空统计 |

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

**统一账单导入（推荐）**

- `POST /imports/jobs/upload`，multipart 字段 `file`；`source` 可不传（或为 `auto`），按文件内容识别微信、支付宝、银行。仍兼容旧客户端显式传 `wechat/alipay/bank`，但不允许来源与内容不符。
- 可传查询参数 `ledgerId`，将上传、预览、确认和提交固定在同一个账本。
- 支持 TXT/CSV/XLSX，以及银行导出的文字版 PDF；XLSX ≤5MB，其余 ≤20MB，单次 ≤5000 条。ZIP 请先解压，加密 PDF 请先解密，扫描件暂不支持。
- 银行 CSV/XLSX 当前支持标准表头：记账日期/交易日期、交易金额/发生额、余额/联机余额/账户余额，可附币种、收支、摘要和流水号；不是所有银行的任意导出格式都能解析。
- 返回 `{item,counts}` 暂存结果，`item.source` 是识别结果；经 `GET /imports/jobs/{id}` 预览、`PATCH /imports/items/{id}` 确认后，再 `POST /imports/jobs/{id}/commit` 正式入账。
- `GET /imports/jobs` 列出当前账本的历史导入任务（含状态与计数），用于「导入记录」回看。
- 账户域已下线：导入只属于当前账本，无需先建账户。
- iOS 从“设置 → 导入账单”进入，不再手动选择微信/支付宝/银行；文件选择器授权在协调读取结束后释放，multipart 上传与普通请求共用登录续期。

**旧 JSON 账单导入（兼容保留）**

- 方式一（原始文件）：
  `{mode:"raw", source:"wechat"|"alipay"|"bank", content:"<文本内容>" 或 contentBase64:"<文件base64>"}`
  - 微信：支持 txt / xlsx；支付宝：csv；银行：文字版 pdf。银行 CSV/XLSX 请使用上面的统一上传接口。
  - 后端自动识别 UTF-8 / GBK 编码
- 方式二（客户端已解析）：
  `{mode:"items", items:[{date, amount, type, note?, externalId?}]}`
- 返回 `{imported, skipped, total}`；硬去重唯一索引为 `(ledger_id, source_type, external_id)`
  （同账本 + 同来源 + 同外部 ID），另有非唯一的 `dedup_key` 软指纹用于"疑似重复"判定。
- 导入流水的分类按**备注关键词自动建议**（医院→医疗、火车票/ETC→交通、京东/超市→购物、美团→餐饮等），
  未命中关键词的留空显示「未分类」——不再默认挂第一个分类（历史上导致 1546 笔支出全部显示为餐饮）。
  暂存明细可逐条改分类后再提交。
- **币种语义**：全站人民币。账单文件里的 `币种` 列只接受人民币/`CNY`/`RMB`/空；
  其他取值整份账单拒绝（400 `BILL_CURRENCY_UNSUPPORTED`），不会静默跳过该行。

新建入参按 `type` 区分：

- 支出/收入：`{type:"income"|"expense", amount, date, categoryId, note?}`
- 转账已随账户域下线移除（历史上同一账本内转账无意义；跨账户请分别记支出与收入）。

校验：分类类型必须与收支类型匹配。`GET /transactions?categoryId=&type=` 按分类/类型过滤。

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
| GET | /stats/summary?year&month | `{income, expense, net, cumulativeNet, byCategory, daily}` |
| GET | /stats/trend?months=6 | `{months:[{year,month,income,expense}]}` |

- `net = income - expense`；`cumulativeNet` 为该账本历史收入 − 支出（不依赖账户；账户域已下线）。
- 负债域与多币种都已下线：没有 `totalDebt`，也没有任何汇率折算（历史外币金额已在迁移里折算成人民币）。
- `byCategory` 为支出按分类汇总（含占比 `percent`）；`daily` 为当月每日收入/支出。

## 共享账本（内部兼容 `/families` 路径）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /families | 一键创建共享账本并切换为当前；同一事务内作废创建者的全部待处理邀请 |
| GET | /families | 当前共享账本的成员关系（最多一项） |
| GET | /families/:id | 共享账本详情（成员 + 账本） |
| POST | /families/:id/invitations | Owner 按精确昵称邀请成员 |
| GET | /families/invitations/pending | 当前用户可处理的共享账本邀请 |
| POST | /families/invitations/:id/accept | 接受邀请并自动进入共享账本，同时撤销其他邀请 |
| POST | /families/invitations/:id/decline | 拒绝邀请 |
| PATCH | /families/:id | 修改共享账本名称 |
| DELETE | /families/:id/members/:memberUserId | 移除成员 |
| GET | /families/:id/invitations | 该共享账本的待处理邀请列表 |
| DELETE | /families/:id/invitations/:inviteId | 撤回一条待处理邀请 |
| POST | /families/:id/exit | 成员主动退出共享账本 |
| POST | /families/:id/transfer | Owner 转让所有权 |
| DELETE | /families/:id | 解散共享账本（数据保留、账本对所有人不可访问） |
| POST | /families/:id/members | **已下线 → 410 `FAMILY_FLOW_REMOVED`**（改为按昵称邀请） |
| PATCH | /families/:id/members/:memberUserId | **已下线 → 410 `FAMILY_FLOW_REMOVED`** |
| GET | /ledgers | 我可见的账本（个人 + 共享） |
| POST | /ledgers/switch | 切换当前账本 `{ledgerId}` |

- 产品界面只暴露“个人账本 / 共享账本”；`family` 仅作为后端兼容的成员关系命名。
- 分类/流水/周期账单/统计等接口支持 `ledgerId`（query 或 body），用于指定共享账本。
- 访问控制：个人账本仅创建者；共享账本仅活跃成员；越权返回 403。

## 账单导入去重

- 导入时生成跨来源指纹 `dedup_key`（日期+金额+规范化商家；指纹载荷里的 `CNY` 是历史格式保留字面量，不是可变币种）
- 默认遇到同账本相同指纹自动跳过，并返回 `suspectedDuplicates`
- `force:true` 可强制新增重复项（清空 `dedup_key` 并记录 `linked_transaction_id`）
- `POST /transactions/link` 可手动将疑似重复流水关联到已有流水

## 健康检查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /health | 返回 `{status:"ok", time}` |
