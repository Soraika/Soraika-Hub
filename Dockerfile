# ─────────────────────────────────────────────────────────────────────────────
# Soraika's Hub —— 单镜像（Node 同时当 API 与静态站）
# -----------------------------------------------------------------------------
# 两阶段：① 完整 node 镜像里把 Web 打出来 ② 运行时只留 prod 依赖 + dist
# 为什么不用 nginx：同源就不需要反代，省一个容器、省一套跨域配置。
# 为什么是 bookworm-slim 而不是 alpine：项目用 Node 内置的 node:sqlite，
#   musl 上偶发缺库，排查成本比省下来的几十 MB 高得多。
# 为什么完全不装 apt 包：node:22-bookworm-slim 自带 /usr/share/zoneinfo（TZ 可用），
#   而 curl/unzip 只是为了下 BaiduPCS-Go —— 改成用 Node 自己下+解（scripts/fetch-baidupcs.mjs），
#   apt 在 NAS 网络下经常 500/超时，能不要就不要。
# ─────────────────────────────────────────────────────────────────────────────

# 基础镜像：默认走国内镜像（直连 registry-1.docker.io 在内地基本拉不动）。
# 境外或有自己的加速器就 --build-arg BASE_IMAGE=node:22-bookworm-slim
ARG BASE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim

# npm 源：同理，默认 npmmirror；要用官方源就 --build-arg NPM_REGISTRY=https://registry.npmjs.org/
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ① 构建前端
FROM ${BASE_IMAGE} AS web
ARG NPM_REGISTRY
WORKDIR /build/Web
COPY Web/package.json Web/package-lock.json ./
RUN npm ci --no-audit --no-fund --registry=${NPM_REGISTRY}
COPY Web/ ./
RUN npm run build

# ② 运行时
FROM ${BASE_IMAGE}
ENV NODE_ENV=production \
    PORT=3100 \
    DB_FILE=data/hub.db \
    WEB_DIR=/app/web \
    TZ=Asia/Shanghai

WORKDIR /app
COPY Server/package.json Server/package-lock.json ./
ARG NPM_REGISTRY
RUN npm ci --omit=dev --no-audit --no-fund --registry=${NPM_REGISTRY} && npm cache clean --force

COPY Server/ ./
COPY --from=web /build/Web/dist ./web

# BaiduPCS-Go（百度离线/转存）：纯 Node 下载+解压，不需要 curl/unzip。
# 下载失败**不会**让构建挂掉 —— 之后把宿主机目录挂到 /app/tools/baidupcs 即可补上。
ARG BAIDUPCS_VERSION=4.0.2
RUN node scripts/fetch-baidupcs.mjs --dest=/app/tools/baidupcs --version=${BAIDUPCS_VERSION} || true

# 数据目录：SQLite 库、海报缓存、百度登录态都落在同一个 volume 里
RUN mkdir -p data && chown -R node:node /app
VOLUME ["/app/data"]

# 不用 root 跑（基础镜像自带 uid 1000 的 node 用户）
USER node

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
