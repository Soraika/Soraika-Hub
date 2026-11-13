# Docker 部署

一个镜像搞定：Node 同时提供 `/api` 和前端静态页（同源，不需要 nginx、不用配跨域）。

## 起起来

```bash
docker compose up -d --build
```

打开 `http://<NAS>:3100`。

首次进设置页填这几样（都存在 `settings` 表里，跟着 volume 走，重建容器不丢）：

| 分组 | 要填什么 |
|---|---|
| 数据源 | 默认 `mikanime.tv` + `bgmapi.anibt.net`，一般不用动 |
| AI | 填 Key 才启用（留空则相关接口回 501） |
| 下载（qB） | 地址 + API Key |
| 迅雷 | 接口地址 / fnOS Cookie / pan_auth / 设备空间（见 `Server/docs/XUNLEI-API.md`） |
| 百度网盘 | 只需填 Cookie，二进制镜像里自带 |

## 环境变量只有四个

配置全部在网页里改（`CONVENTIONS.md §6`），所以 `.env` 只留「进程起来之前就得知道」的：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3100 | 监听端口 |
| `DB_FILE` | data/hub.db | SQLite 位置（相对 `/app`） |
| `LOG_LEVEL` | info | pino 级别，`debug` 会打出每个上游请求 |
| `TZ` | Asia/Shanghai | 「每日 04:00 更新」按它算 |

> ⚠️ 其它 `WORKER_INLINE`、`QB_*`、`XUNLEI_*`、`BAIDU_*` 之类**不会从环境变量读**，
> 它们在设置页里改。别以为 `-e` 一个就能覆盖。

## 数据都在一个 volume 里

```
/app/data
├── hub.db          SQLite（番剧库 + settings）
├── img/            海报缓存
└── baidu/          BaiduPCS-Go 的登录态（BAIDUPCS_GO_CONFIG_DIR 指到这）
```

备份就一句：把 `hub-data` 这个 volume 拷走。

## BaiduPCS-Go

镜像构建时用 `Server/scripts/fetch-baidupcs.mjs`（纯 Node，不需要 curl/unzip）
从 GitHub 镜像下载并解压到 `/app/tools/baidupcs/BaiduPCS-Go`。

- 下载失败**不会**让构建挂掉，只是百度相关接口会回「还没配置」。
- 想换版本 / 换架构（arm64 NAS）：
  ```bash
  docker build --build-arg BAIDUPCS_VERSION=4.0.2 .
  # 或直接把宿主机目录挂进去
  # - ./Server/tools/baidupcs:/app/tools/baidupcs:ro
  ```
- 手动补：`docker exec -it soraika-hub /app/tools/baidupcs/BaiduPCS-Go -v` 能出版本号就行。

## 国内网络

镜像里已经处理了三处（都能用 build-arg 覆盖）：

| 项 | 默认 | 覆盖 |
|---|---|---|
| 基础镜像 | `docker.m.daocloud.io/library/node:22-bookworm-slim` | `--build-arg BASE_IMAGE=node:22-bookworm-slim` |
| npm | `registry.npmmirror.com` | `--build-arg NPM_REGISTRY=https://registry.npmjs.org/` |
| BaiduPCS-Go | `ghfast.top` 镜像，失败自动换下一个 | 见上 |

镜像里**不装任何 apt 包**：`node:22-bookworm-slim` 自带 `/usr/share/zoneinfo`（`TZ` 生效），
`curl`/`unzip` 用不到 —— 下载解压都交给 Node 自己做。少了这一步，
NAS 上 apt 源抖动（实测 500/unexpected EOF）就不会再卡住构建。

## 后台队列要不要单独容器

默认跟着 API 进程跑（`worker.inline = true`），单容器最省事。

要拆开：设置页关掉「跟随服务进程」，然后

```yaml
  worker:
    image: soraika-hub:latest
    command: ["node", "src/jobs/worker.js"]
    volumes: ["hub-data:/app/data"]
    depends_on: [hub]
```

## 更新

```bash
git pull
docker compose up -d --build     # 数据在 volume 里，不会丢
```

## 健康检查

镜像自带 `HEALTHCHECK`（打 `/api/health`），`docker ps` 会显示 `healthy`。
`docker stop` 会走优雅停机：先停队列等手上那一条落库 → 停接收新请求 → 关 SQLite。
