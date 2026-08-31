# HTTPS 部署（上线前必须）

开发期 App 直连本地/局域网 HTTP（ATS 仅放行本地网络）。上 HTTPS 后生产客户端
只允许 HTTPS 域名，消灭明文传输，并让 App 商店审核与真实用户可用。

## 前置
- 需要一个**域名**（Let's Encrypt 不给纯 IP 签证书）。
- 域名 A 记录指向服务器公网 IP（部署方按实际情况填写）。
- 云厂商安全组放行 `80` 和 `443`。

## 方案一：Caddy（推荐，自动证书/续期）—— 仓库自带可直接运行的生产栈

仓库提供 `backend/docker-compose.caddy.yml` + `backend/Caddyfile`（Caddy 与后端同网络，
**只有 Caddy 对宿主发布 80/443**，后端 8080 只在 Docker 内网可达）：

```bash
cd backend
export TALLY_DOMAIN=your-domain.cn                    # 必填：已解析到本机的正式生产域名（不给纯 IP 签证书）
export ACME_EMAIL=ops@example.com                  # 必填：证书联系邮箱 + ZeroSSL 备用签发
export JWT_SECRET=$(openssl rand -hex 32)         # 必填：≥32 位强随机，占位值会被拒绝启动
export CORS_ORIGINS=https://your-domain.cn            # 可选：有 Web 端才需要
docker compose -f docker-compose.caddy.yml config --quiet   # 先校验渲染结果
docker compose -f docker-compose.caddy.yml up -d --build
docker compose -f docker-compose.caddy.yml ps               # 两个服务都应 healthy
curl -sS https://$TALLY_DOMAIN/health/ready
```

要点：
- 站点地址由 `TALLY_DOMAIN` 注入 Caddyfile（`{$TALLY_DOMAIN}`），**没有默认值**：忘填会直接启动失败，
  避免把 `example.com` 之类占位域名带上线。
- ACME 联系邮箱由 `ACME_EMAIL` 注入且没有默认值；非空邮箱让 Caddy 在 Let's Encrypt 不可用时
  自动回退到 ZeroSSL，并用于证书异常通知。
- 命名卷：`tally-data`（SQLite）、`caddy_data`（证书/ACME 账户，删了会重新签发并受速率限制）、`caddy_config`。
- 两个服务都有 `healthcheck`、`restart: unless-stopped`、日志轮转（10MB×5）。
- 只想在服务器上手工跑 Caddy（不用 Docker）时，可参考模板 `backend/Caddyfile.example`。

## 方案二：Nginx + certbot
```nginx
server {
    listen 443 ssl;
    server_name tally.example.com;
    ssl_certificate     /etc/letsencrypt/live/tally.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tally.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 上线后 App 端收尾
1. **关闭公网直连 8080**：安全组仅保留 22/80/443。
2. ATS 已默认收紧：不再使用全局 `NSAllowsArbitraryLoads`，仅保留 `NSAllowsLocalNetworking`（本地/局域网 HTTP 联调）。生产如不需要局域网 HTTP，可一并移除。
3. API 地址由**构建配置注入**，Release **故意没有默认值**（占位域名不允许进产物）：
   ```bash
   xcodebuild -project ios/Tally.xcodeproj -scheme Tally -configuration Release \
     ... TALLY_API_BASE_URL=https://your-domain.cn
   ```
   - 构建期由 Run Script 调 `ios/scripts/validate-api-url.sh` 校验：空值、`$(...)` 未展开、
     `http://`、`localhost`/`127.x`/私网 IP/裸 IP、单标签主机名（容器服务名）、
     `example.com`/`.test`/`.invalid` 以及 `your-*`、`placeholder` 等占位词一律 **构建失败**。
   - 产物复核：`ios/scripts/validate-api-url.sh --plist path/to/Tally.app`（读产物里的 Info.plist）。
   - `APIClient` 在 Release 再兜一层：非 HTTPS 或本机/示例/占位域名直接 `fatalError` 拒绝启动。
4. 后端在反向代理后设置 `TRUST_PROXY=1`（才能正确还原客户端 IP 做限流；客户端伪造的左侧 XFF 会被忽略）。
5. 重新构建/安装 App。

## 安全核对

完整上线核对见 [production-checklist.md](production-checklist.md)（域名/TLS/JWT/CORS/TRUST_PROXY、
迁移前备份、异机备份与恢复演练、健康检查/日志/告警）。最少必须勾完：

- [ ] 公网 8080 已关闭（compose 未对后端发布任何端口；安全组只留 22/80/443）
- [ ] 域名已配置，`https://你的域名/health/live` 返回 ok，`/health/ready` 的 `migrationsApplied` > 0
- [ ] App 通过 https 正常登录/记账/导入
- [ ] 生产 `JWT_SECRET` 为 ≥32 位强随机且非占位值
- [ ] 生产 `CORS_ORIGINS` 已显式列出前端域名（或确认无需放行任何浏览器 Origin）
- [ ] 后端位于反代之后时 `TRUST_PROXY=1`
- [ ] 短信（`ALIYUN_SMS_*`）已配置：短信验证码是唯一登录通道，否则生产登录返回 503（无密码/无重置/无邮箱）
- [ ] 仅 22/80/443 对外开放
