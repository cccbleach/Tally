# ---- 构建阶段 ----
FROM node:24-slim AS build
WORKDIR /app
RUN sed -i "s|deb.debian.org|mirrors.aliyun.com|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++ && \
    corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN pnpm build

# ---- 运行阶段 ----
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# 镜像内默认钉住生产认证模式：development 会把短信验证码明文回传给请求方，
# 裸 `docker run`（未显式传 AUTH_MODE）时也必须是安全默认值。
ENV AUTH_MODE=production
# better-sqlite3 是原生模块，安装时需要 python3/make/g++ 编译；
# 编译完成后在同一层内卸载工具链并清理 apt 缓存，避免把编译器留在生产镜像里
# （运行期不再需要编译任何东西；已编译产物留在 node_modules 中）。
RUN sed -i "s|deb.debian.org|mirrors.aliyun.com|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++ && \
    corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 只精确卸载这三个包本身（不用 --auto-remove：避免 apt 顺带移除运行期依赖，
# 该镜像的运行期可用性由 CI 的 Docker/compose/容器级回归验证）
RUN pnpm install --frozen-lockfile --prod && \
    apt-get purge -y python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
EXPOSE 8080
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
