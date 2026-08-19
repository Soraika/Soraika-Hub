# ── 阶段 1：构建前端 ──
FROM node:20-alpine AS frontend

WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ── 阶段 2：运行时（仅包含产物，不含任何本机配置/数据） ──
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data

# 仅复制 server 的依赖清单并安装生产依赖
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev --no-package-lock

# 复制服务端源码（不包含本机 config.json / data，由 .dockerignore 兜底）
COPY server/ ./

# 复制前端构建产物
COPY --from=frontend /app/client/dist ./client/dist

# 创建非 root 用户，提升容器安全性
# /data 挂载卷首次创建后所有权通常为 root，给 app 用户读写权限：
# chmod 1777 类似 /tmp 的 world-writable，保证命名卷即使 root 所有也能写入
RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /data \
  && chown -R app:app /app \
  && chmod 1777 /data

USER app

VOLUME ["/data"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1

CMD ["node", "app.js"]