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
RUN sed -i "s|deb.debian.org|mirrors.aliyun.com|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++ && \
    corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
EXPOSE 8080
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
