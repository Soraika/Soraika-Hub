# Soraika's Hub

> 自托管番剧资源管理面板：Mikan 排期浏览、Bangumi 评分推荐、AI 智能解析、qBittorrent 一键下载。
> 适合部署在 NAS / 家用服务器上，全程自控、数据与配置持久化在本机卷中。

---

## 功能特性

- **首页番剧排期**：按星期浏览 Mikan 当季 / 历史季度番剧，剧院版 / OVA 独立区块
- **发现页推荐引擎**：基于 Bangumi 评分与热度生成 4 个模块（口碑 / 热门 / 值得一试 / 人气之作），支持「换一批」
- **番剧详情面板**：海报、BGM 评分/简介、字幕组列表、RSS 种子一键选择
- **AI 智能解析**：接入 DeepSeek，自动提取文件标签分类、解析季数与集数，下载后自动重命名
- **qBittorrent 集成**：添加下载任务、自动分类、批量下载、重命名、状态管理
- **Mikan ↔ Bangumi 转换表**：每日自动同步官方数据，详情页精准关联，设置页可配镜像地址
- **结构化日志**：全端接入 pino，JSON 结构化、HTTP 访问日志、按日轮转、敏感信息自动脱敏

---

## 技术栈

| 端 | 技术 |
|---|---|
| 前端 | Vue 3 · Vite · Pinia · Vue Router · @tabler/icons-vue · @phosphor-icons/vue |
| 后端 | Node.js · Express 5 · better-sqlite3 · cheerio · fast-xml-parser |
| AI | DeepSeek API（标签分类 / 标题解析） |
| 日志 | pino · pino-http · pino-roll |
| 部署 | Docker · GitHub Actions 自动构建推送镜像 |

---

## 快速开始（Docker 推荐）

### 前提

一台可访问 Mikan / Bangumi / qBittorrent 的主机（如 NAS），已安装 Docker。

### 部署

```bash
git clone https://github.com/Soraika/Soraika-Hub.git
cd Soraika-Hub
docker compose up -d
```

访问 `http://<服务器IP>:3001`，首次启动后进入「设置」页完成配置。

### 数据与配置

- 数据卷 `soraika-data` 挂载到容器 `/data`，其中保存：
  - `config.json` — 全部配置（Mikan/Bangumi/DeepSeek/qBittorrent/转换表）
  - `soraika.db` — SQLite 数据库（下载记录等）
  - `bangumi-mikan.json` — Mikan↔Bangumi 转换表本地缓存
  - `logs/` — 按日轮转的日志文件（保留约 7 天）
- **升级镜像不会丢失任何数据**（卷独立于镜像）。

---

## 设置页配置项

| 区块 | 字段 | 说明 |
|---|---|---|
| 下载 | qBittorrent URL / Token / 下载基础路径 | 必填，用于添加与管理下载任务 |
| AI | DeepSeek API 地址 / Key / 模型 | 标签解析与标题识别 |
| 数据源 | Mikan 镜像地址 | Mikan 站点镜像（默认 `https://mikanani.kas.pub/`） |
| 数据源 | Bangumi API 地址 / Token | 评分与条目信息（可选 Token） |
| 数据源 | Mikan→Bangumi 转换表镜像地址 | 每日自动同步；国内网络可填 jsDelivr 等加速地址 |

---

## 本地开发

```bash
# 安装全部依赖（根 + client + server）
npm run install:all

# 同时启动前端（vite）与后端（node）
npm run dev:all

# 只跑后端（原始 JSON 日志 / pino-pretty 美化）
npm run dev:server
npm run dev:server:pretty
```

---

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 服务端端口 | `3001` |
| `DATA_DIR` | 数据目录（配置 / 数据库 / 日志 / 转换表缓存） | `server/data` |
| `LOG_LEVEL` | 日志级别：`debug` / `info` / `warn` / `error` | `info` |
| `LOG_OUTPUT` | 日志输出：`both`(stdout+文件) / `stdout` / `file` | `both` |
| `LOG_DIR` | 日志目录（覆盖默认的 `DATA_DIR/logs`） | — |

---

## API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/config` | 读取 / 更新配置 |
| GET | `/api/mikan/schedule` | 番剧排期（按星期 / 历史季度） |
| GET | `/api/mikan/subdetail/:id` | 番剧详情（字幕组列表；兼容 Mikan ID 与 Bangumi ID） |
| GET | `/api/mikan/rss/:bangumiId/:subgroupId` | 字幕组资源（RSS） |
| GET | `/api/mikan/search?q=` | 番剧搜索 |
| GET/POST | `/api/mikan/mapping` `/api/mikan/mapping/sync` | 转换表状态 / 立即更新 |
| POST | `/api/classify/tags` `/api/classify/download` | AI 标签分类 / 标题解析 |
| GET | `/api/bgm/subject/:id` `/api/bgm/search` | Bangumi 条目详情 / 搜索 |
| GET/POST/DELETE | `/api/qb/*` | qBittorrent 状态 / 下载 / 重命名 |
| GET | `/api/discover/modules` `/api/discover` | 发现页推荐模块 / 换一批 |

---

## 目录结构

```
client/                前端（Vue 3 + Vite）
  src/pages/           首页 / 发现页 / 搜索页 / 下载页 / 设置页
  src/components/      卡片、详情面板、字幕组选择等
  src/utils/logger.js  前端日志封装（pino browser）
server/                后端（Express）
  routes/              API 路由
  services/            Mikan 解析 / Bangumi / 推荐引擎 / 分类器 / 转换表
  utils/logger.js      日志封装（pino + pino-http + pino-roll）
  data/                运行时数据（db / 日志 / 转换表缓存，gitignore）
deploy/                部署脚本
.github/workflows/     GitHub Actions 自动构建推送镜像
```

---

## 日志说明

- 服务端输出 JSON 结构化日志，格式示例：
  ```json
  {"level":30,"time":"2026-08-25T08:00:00.000Z","service":"soraikas-hub","tag":"mikanMapping","msg":"转换表已更新：3169 条"}
  {"level":30,"time":"2026-08-25T08:00:01.000Z","service":"soraikas-hub","req":{"id":3,"method":"GET","url":"/api/mikan/mapping"},"res":{"statusCode":200},"responseTime":5}
  ```
- 默认同时写 stdout（`docker logs`）与 `DATA_DIR/logs`（按日轮转，保留约 7 天）。
- 敏感信息（`sk-*` / `Bearer *` / token / apiKey / password 等）自动脱敏。
- 本地开发可用 `npm run dev:server:pretty` 获得美化可读输出。

---

## 升级与备份

```bash
# 升级（卷不动、数据不丢）
docker compose pull
docker compose up -d --force-recreate

# 备份数据卷
docker compose stop
docker run --rm -v soraika-data:/data -v "$PWD/backup":/backup alpine \
  tar czf /backup/soraika-data.tar.gz -C /data .
docker compose start
```

> 设计规范见 [DESIGN.md](./DESIGN.md)；项目内部 AI 变更记录不随仓库公开。

---

## 声明

- 本项目仅用于个人学习与自托管使用，数据来自 Mikan / Bangumi / qBittorrent 等第三方服务。
- 请遵守各站点/服务的使用条款；请勿将本项目用于商业用途。
- 镜像与源码均为公开仓库，请勿在其中写入任何真实密钥（通过设置页 / 卷内 `config.json` 配置）。
