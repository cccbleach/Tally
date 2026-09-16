# 凭证与历史卫生（改公开仓库前必读）

本仓库**当前状态自检结果**（2026-09-15，工作区 + 全部历史）：

| 检查项 | 结果 |
|---|---|
| 云厂商 AK（阿里云 `LTAI…` / AWS `AKIA…` / 腾讯 `AKID…`） | ✅ 无 |
| GitHub / Slack / OpenAI 令牌 | ✅ 无 |
| 私钥文件内容 | ✅ 无 |
| `.env` / `.db` / `.p12` / `.mobileprovision` 等敏感文件入库 | ✅ 无（仅 `.env.example` 占位） |
| 服务器公网 IP | ✅ 无（文档里只有 `203.0.113.x` 等 RFC 文档示例段） |
| 真实短信签名 / 模板 / 手机号 | ✅ 无 |
| 生产域名与运维邮箱 | ✅ 已改为占位（`your-domain.cn` / `ops@example.com`）；CI 用的真实域名移到**仓库变量** `PROD_API_BASE_URL` |
| 历史里的 Xcode 个人状态（`xcuserdata`） | ✅ 已清理（`git filter-repo` 剔除 + 全历史强推，2026-09-16） |
| 历史里的本机路径 `/Users/<用户名>` | ✅ 已清理（全历史文本替换为 `<用户名>` / `<仓库路径>`） |
| 历史里的生产域名 | ✅ 已清理（全历史文本替换为 `your-domain.cn`，2026-09-16）。**域名原文不再写入本仓库** —— 包括本表：把被清理的字符串当成"已完成记录"再抄一遍，等于二次泄漏 |
| 当前树的生产域名 | ✅ 仅占位（`your-domain.cn`）；真实域名只存在于部署机的 `/etc/tally/tally.env`、Caddyfile 与仓库变量 `PROD_API_BASE_URL`，均不在源码里 |

## 1. 日常：两道扫描

```bash
# 一道命令跑完三层（高置信度特征 + 历史 + gitleaks 深度扫描）
./scripts/check-no-secrets.sh
./scripts/check-no-secrets.sh --worktree   # 只扫工作区，快（不扫历史/gitleaks）
```

三层分别是什么：

| 层 | 实现 | 覆盖 |
|---|---|---|
| 高置信度特征 | `scripts/check-no-secrets.sh`（内置正则） | 阿里云 `LTAI`/AWS `AKIA`/腾讯 `AKID`/GitHub·Slack·OpenAI 令牌/私钥头/JWT，**含完整历史** |
| 熵 + 关键词 | `detect-secrets`（可选，`pip3 install --user detect-secrets`） | 高熵字符串、`*_secret`/`*_key` 赋值等 |
| 规则库深度扫 | `gitleaks`（可选，`brew install gitleaks`） | 150+ 供应商规则；配置见仓库 `.gitleaks.toml` |

CI 的 `hygiene` job 已内置第一层（提交即拦截，零外部依赖）。

**为什么 CI 只内置第一层**：gitleaks/detect-secrets 需要联网下载或额外安装，
把网络依赖放进 CI 会引入新的失败模式（构建因为下载失败而红）。深度扫描按需在本地跑，
或在改公开仓库、上线发版前手动跑一次即可。

**2026-09-16 三层扫描结果**：工作区与全历史均无真实凭证。仅有的命中是两类良性命中，
已在 `.gitleaks.toml` 按**secret 内容**（而非整目录）加窄白名单：

- `backend/test/*.test.ts` 里测试进程用的假 JWT 密钥（`"…-secret-0123456789"` 形态）
- `pnpm-lock.yaml` 的 `integrity: sha512-…` 完整性哈希、Xcode 工程的 24 位对象 ID

门禁刻意**只匹配高置信度特征**：低置信度规则（如任意 `SECRET=` 长字符串）会命中测试用的假密钥，
造成误报——门禁一旦误报就会被绕过，等于没有门禁。

## 2. 万一泄漏：先轮换，再清历史

顺序不能反：**历史清理再干净，泄漏过的凭据也必须视为已失效**。

1. **轮换**：阿里云 RAM → AccessKey 管理（禁用旧的、建新的）→ 更新服务器环境变量与本地 `.env` → 重启后端。
   JWT 泄漏则换 `JWT_SECRET`（全部会话立即失效）。
2. **确认影响面**：谁能读到？（公开仓库 = 所有人；私有仓库 = 协作者 + GitHub 侧日志）
3. **清历史**（见下节）。
4. **联系 GitHub Support 清除孤儿对象**：强推后旧提交对象在 GitHub 侧**不会立即消失**，
   知道旧 SHA 的人仍可能通过 `…/commit/<旧SHA>` 或 API 取到内容。证书类/密钥类泄漏必须让 Support 彻底清除。

## 3. 清理历史里的 `xcuserdata`（Xcode 个人状态）——**已执行，保留步骤备查**

> 已于 2026-09-16 执行：历史里的 9 处 `xcuserdata` 路径、5 个含本机路径的提交、
> 3 个含生产域名的提交全部清理，并强推（`0482b2f` → `829565d`）。
> 校验：`HEAD^{tree}` 在重写前后**完全一致**（内容零变化），提交数 65 未变。

历史里曾存在（内容仅本机路径 `/Users/<用户名>/…` 与 Xcode 设备占位串，无凭证）：

- `ios/Tally.xcodeproj/project.xcworkspace/xcuserdata/`
- `ios/Tally.xcodeproj/xcuserdata/`

步骤（**会改写全部提交 SHA，必须强推**）：

```bash
brew install git-filter-repo

cd <仓库路径>   # 例如 clone 后的 Tally 目录
git status                      # 必须干净
git filter-repo --invert-paths \
  --path ios/Tally.xcodeproj/project.xcworkspace/xcuserdata \
  --path ios/Tally.xcodeproj/xcuserdata \
  --force

# filter-repo 出于安全会移除 origin，需要重新加回
git remote add origin git@github.com:cccbleach/Tally.git
git push --force --all origin
git push --force --tags origin

# 校验：历史里应再无 xcuserdata
git log --all --name-only --pretty=format: | grep -c xcuserdata   # 期望 0
```

**影响（务必知悉）**：
- 所有 commit SHA 变化 → 任何已有克隆都必须重新 clone（或 `git fetch && git reset --hard origin/main`）
- 已有的 GitHub Actions 运行记录会指向不存在的 SHA（显示为孤立记录，不影响新运行）
- 若有人 fork 过，其分支不会自动更新
- 强推不删除 GitHub 侧旧对象（见上节第 4 点）

## 4. 改公开仓库前的检查清单

- [ ] `./scripts/check-no-secrets.sh` 通过（工作区 + 历史）
- [ ] `gitleaks detect --source . --redact` 通过（可选，更彻底）
- [ ] 生产域名/运维邮箱已脱敏（或已迁移到仓库变量/Secrets）
- [ ] 历史里的个人信息已清理或确认可接受（如 `xcuserdata` 中的本机路径与用户名）
- [ ] 已添加 `LICENSE`（本仓库为 MIT）
- [ ] 确认 `.gitignore` 覆盖：`.env`、`backend/data/`、`backups/`、`dist/`、`node_modules/`、`xcuserdata/`
- [ ] 决定是否需要在 GitHub 侧开启：Secret scanning、Push protection（公开仓库免费）
- [ ] 提醒：**iOS Release 产物里已经包含生产 API 地址**（`Info.plist` 的 `TallyAPIBaseURL`），
      装过 App 的任何人可读出 → 域名不值得当作秘密来保护，但也没必要在文档里高亮
