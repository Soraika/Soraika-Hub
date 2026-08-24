# ── 阶段 1：构建前端 ──
FROM node:22-alpine AS frontend

WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ── 阶段 2：运行时（仅包含产物，不含任何本机配置/数据） ──
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
# PUID/PGID：容器内运行服务的 uid/gid（默认 1000:1000，与常见 NAS 首个用户一致）
# 部署时可覆盖为宿主用户，如 PUID=$(id -u) PGID=$(id -g)
ENV PUID=1000
ENV PGID=1000

# 仅复制 server 的依赖清单并安装生产依赖
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev --no-package-lock

# 复制服务端源码（不包含本机 config.json / data，由 .dockerignore 兜底）
COPY server/ ./

# 复制前端构建产物
COPY --from=frontend /app/client/dist ./client/dist

# 创建 app 用户 + 安装 su-exec（入口脚本降权用）
RUN addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app \
  && apk add --no-cache su-exec

# 容器入口：root 启动 → 适配 PUID/PGID 并 chown /data → su-exec 降权运行
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/data"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "app.js"]