# HTTPS 部署（上线前必须）

开发期 App 直连本地/局域网 HTTP（ATS 仅放行本地网络）。上 HTTPS 后生产客户端
只允许 HTTPS 域名，消灭明文传输，并让 App 商店审核与真实用户可用。

## 前置
- 需要一个**域名**（Let's Encrypt 不给纯 IP 签证书）。
- 域名 A 记录指向服务器公网 IP（部署方按实际情况填写）。
- 云厂商安全组放行 `80` 和 `443`。

## 方案一：Caddy（推荐，自动证书/续期）
仓库已带模板 `backend/Caddyfile.example`：

1. 把 `tally.example.com` 换成你的域名。
2. 用 compose 叠加 Caddy（见下方示例）或直接在服务器跑 Caddy：
   ```bash
   cd /opt/tally/backend
   # 安装 caddy 后：
   caddy run --config Caddyfile.example
   ```
3. Caddy 自动申请并续期 HTTPS 证书，反代到内网 `tally-backend:8080`。

### Docker Compose 叠加示例（backend/docker-compose.caddy.yml）
```yaml
services:
  tally-backend:
    extends:
      file: docker-compose.yml
      service: tally-backend

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile.example:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - tally-backend

volumes:
  caddy_data:
  caddy_config:
```

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
3. API 地址由**构建配置注入**：把 Release 的 `TALLY_API_BASE_URL`（`ios/project.yml` 的 `configs.Release`，或 `xcodebuild ... TALLY_API_BASE_URL=https://你的域名`）改为 `https://你的域名`。
   `Info.plist` 的 `TallyAPIBaseURL` 为 `$(TALLY_API_BASE_URL)`；`APIClient` 在 Release 强制校验 HTTPS，非 HTTPS 直接拒绝启动。
4. 后端在反向代理后设置 `TRUST_PROXY=1`（才能正确还原客户端 IP 做限流；客户端伪造的左侧 XFF 会被忽略）。
5. 重新构建/安装 App。

## 安全核对
- [ ] 公网 8080 已关闭
- [ ] 域名已配置，浏览器访问 `https://你的域名/health/live` 返回 ok
- [ ] App 通过 https 正常登录/记账/导入
- [ ] 生产 `JWT_SECRET` 为 ≥32 位强随机且非占位值
- [ ] 生产 `CORS_ORIGINS` 已显式列出前端域名
- [ ] 仅 22/80/443 对外开放
