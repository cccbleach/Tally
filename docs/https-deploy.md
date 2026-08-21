# HTTPS 部署（上线前必须）

开发期 App 直接连 `http://120.26.23.15:8080`。上 HTTPS 后可收紧 ATS、
消灭明文传输，并让 App 商店审核与真实用户可用。

## 前置
- 需要一个**域名**（Let's Encrypt 不给纯 IP 签证书）。
- 域名 A 记录指向服务器公网 IP（本机 `120.26.23.15`）。
- 阿里云安全组放行 `80` 和 `443`。

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
2. 把 `ios/project.yml` 与 `Tally/Support/Info.plist` 的 ATS 收紧：
   - `NSAllowsArbitraryLoads` 改回 `false`
   - `NSAllowsLocalNetworking` 按需保留
3. 把 `APIClient.baseURL` 改为 `https://你的域名`（并清理旧设置）。
4. 重新构建/安装 App。

## 安全核对
- [ ] 公网 8080 已关闭
- [ ] 域名已配置，浏览器访问 `https://你的域名/health/live` 返回 ok
- [ ] App 通过 https 正常登录/记账/导入
- [ ] 仅 22/80/443 对外开放
