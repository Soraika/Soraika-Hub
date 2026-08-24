# Soraika's Hub — 设计 & 系统规范

> 本文为项目级设计与系统约定沉淀文档。凡涉及配色、动画、交互反馈、导航布局、图标、网格等前端/系统级要求的改动，均应在此追加记录，保持风格统一。

## 一、配色

主题：暖色系 + 冷暖点缀，整体柔和、偏纸质质感。

### 全局色（浅色 / 深色）

| 变量 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--accent` | `#e0877a` | `#e0877a` | 主操作色（珊瑚） |
| `--accent-gold` | `#d9a97c` | `#d9a97c` | 金色点缀 / 星期地铁线 |
| `--bg-main` | `#fbf7f2` | `#29252b` | 页面主背景 |
| `--bg-sidebar` | `#f7f1ea` | `#302b31` | 侧边栏背景 |
| `--text-primary` | `#3d3733` | `#f5f0e8` | 主文字 |
| `--text-secondary` | `#9a8f87` | `#b3aaa3` | 次要文字 |

### 四模块主题色（口碑 / 热门 / 值得一试 / 人气之作）

| 模块 | 变量 | 浅色 strong | 深色 strong |
|---|---|---|---|
| 口碑 praise | `--mod-praise: #ddb25e`（金黄） | `#b78a32` | `#e7c67f` |
| 热门 hot | `--mod-hot: #e0913f`（琥珀） | `#bd6f1f` | `#eaa96b` |
| 值得一试 try | `--mod-try: #e0733f`（蜜橙） | `#c15428` | `#e88f65` |
| 人气之作 popular | `--mod-popular: #d95f4a`（暖红） | `#b94736` | `#e47a65` |

> 四个模块统一为「金黄 → 琥珀 → 蜜橙 → 暖红」的暖色渐进，低饱和、同色系，不做割裂的阵营色，避免"给番剧分三六九等"的观感。渐变轨道 `--metro-grad: linear-gradient(90deg, #ddb25e, #d95f4a)`。

## 二、发现页区块设计

- **首块融合**：第一个模块（口碑）不显示独立标题，内容直接衔接顶部引导栏，形成"顶栏融入正文"的观感。
- **后块分隔**：第 2 个及之后的模块各显示一条细标题分隔（icon + 名称 + 数量），作为区块边界。
- **滚动接管**：顶部引导栏的「当前模块名」随滚动用淡入/上滑过渡平滑切换，与内容区块位置对应。

## 三、导航栏（固定，不浮动）

- 首页 `topbar` 与发现页 `module-nav` 必须 **实色不透明**，紧贴滚动容器顶部，带清晰底边线。
- **禁止**负 margin + 半透明 `backdrop-filter` + 圆角悬浮卡片质感。
- 使用 `position: sticky; top: 0` 锚定在各自滚动容器（`.home-main` / `.discover-main`）顶部，z-index 独立高于内容。
- 首页引导栏顺序固定为：**季度选择器 → 搜索框 → 星期地铁图**。
- 发现页引导栏为**单条同行**：`[当前模块标识 + 名称] ｜ [4 站地铁图] ｜ [换一批按钮]`。
- 模块标题（`module-header`）不再是 sticky，不带换一批按钮。

## 四、地铁图进度连线（动态进度条）

- 每条连线 = 浅灰轨道 + 主题色填充层。
- 填充宽度随滚动用 `IntersectionObserver` + scroll 计算连续进度。
- 缓动统一 `--ease-out: cubic-bezier(0.22, 1, 0.36, 1)`，填充过渡 0.5s 平滑「流」过，不生硬。
- 已走过站点圆点实心亮起带光晕，未到站点空心灰。
- **首页星期地铁图固定 7 站**：日/一/二/三/四/五/六，顺序固定，填充进度走满 7 站周期（终点=周六）。不做"今天环绕"切换。
- 发现页模块地铁图 4 站：口碑/热门/值得一试/人气之作。
- **剧场版 / OVA**：不进入地铁图，作为 7 天之后的独立区块（有数据显示、无数据不渲染）。

## 五、图标库约定

- **业务 / 交互图标**：`@tabler/icons-vue`（stroke 风格），模块/按钮/状态图标均用它。
- **侧边栏图标**：`@phosphor-icons/vue`（weight="bold"）。
- 模块图标映射：praise=`IconTrophy`、hot=`IconFlame`、try=`IconSparkles`、popular=`IconUsers`、today=`IconCalendar`。

## 六、交互反馈

- 过渡曲线：`cubic-bezier(0.22, 1, 0.36, 1)`；常规时长 0.2s–0.35s，地铁填充 0.5s。
- hover：卡片上浮 `translateY(-4~5px)` + 柔和阴影 + 海报轻微放大。
- 导航站点 hover：圆点放大、文字加深。
- disabled/loading：降透明度 + `cursor: not-allowed` / `wait`，spinner 节流避免闪烁。
- 可访问性：可聚焦元素保留 `:focus-visible` outline；`prefers-reduced-motion: reduce` 关闭非必要动画/过渡。

## 七、卡片规范

- 结构：`顶部信息条(左 badge 标签 / 右 评分+人数)` → `干净海报` → `底部(标题 + 年份·题材)`。
- 海报区域不允许被标签/评分覆盖。
- 顶部信息条需 `flex-wrap + min-width:0 + ellipsis`，评分人数过长省略，不遮挡。
- 首页卡片 badge 显示星期（日/一/…/六），发现页显示模块名；两者都展示评分 + 人数 + 年份·题材。

## 八、网格规范

- 卡片网格统一 `grid-template-columns: repeat(auto-fill, minmax(170px, 1fr))`，缺口换行而非压缩缩放。
- 两页（首页 / 发现页）保持同一网格规则，避免评分被挤压遮挡。

## 九、注意事项 / 避坑

### 图标库
- 项目存在两套图标库，**不要混用**：
  - 业务/交互图标用 `@tabler/icons-vue`（stroke 风格）。
  - 侧边栏导航用 `@phosphor-icons/vue`（weight="bold"）。
- 禁止在代码里写 emoji 或乱码字符作为图标，图标一律走图标库组件；后端兜底字段的 icon 只能是纯文本占位，前端不透出。

### 设计要求
- **同色系渐进，不搞"阵营色"**：多个推荐模块本质是同一批番剧的不同筛选维度，配色应使用同一色系（如暖金 → 暖橙）低饱和渐进，避免四种割裂色相造成"给番剧分三六九等"的观感。
- **海报必须干净**：标签/评分不得覆盖在海报图片上，统一放到卡片顶部信息条。
- **信息不重复**：导航/引导栏已经展示的信息（如当前模块名、星期），不要在紧邻的内容区又重复一块标题。
- **卡片标签宁短勿长**：小标签显示不全时，优先只保留"评分 + 人数"这类稳定短信息，或换行/省略，不硬塞长名词。
- **导航栏固定不浮动**：用实色背景 + 顶部锚定，不做半透明毛玻璃 + 负 margin 的悬浮卡片质感。
- **网格缺口换行，不缩放压缩**，避免卡片内容（评分等）被挤压遮挡。

### 接口未就绪的前端策略
- 首页排期接口原本不返回评分/题材，后端已加 `getSubjectMeta` 补全但可能不稳定。**在接口稳定前，首页卡片不展示评分/分类**，只保留星期徽标与番名/海报；发现页卡片正常展示评分 + 人数。

## 十、Docker 部署与在线升级

### 镜像 / 仓库约定
- 镜像发布到 **Docker Hub 公开仓库**：`soraika/soraikas-hub`。
- 源码发布到 **GitHub 公开仓库**：`https://github.com/Soraika/Soraija-Hub`。

### 构建并推送镜像（自动化：GitHub Actions）
仓库已内置 `.github/workflows/docker.yml`：**打 tag 即自动构建并推送镜像到 Docker Hub**，无需本地安装 Docker。

1. 首次配置：GitHub 仓库 → **Settings → Secrets and variables → Actions**，新增两个 secret：
   - `DOCKERHUB_USERNAME` = `soraika`
   - `DOCKERHUB_TOKEN` = Docker Hub 的 Access Token（hub.docker.com → Account Settings → Security → New Access Token，需 Read/Write 权限）
2. 发布新版：
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
   Actions 自动构建并推送 `soraika/soraikas-hub:1.0.0` 与 `soraika/soraikas-hub:latest`。

> 若想在本地手动构建推送（需装 Docker）：`docker build -t soraika/soraikas-hub:1.0.0 . && docker tag soraika/soraikas-hub:1.0.0 soraika/soraikas-hub:latest && docker push soraika/soraikas-hub:1.0.0 && docker push soraika/soraikas-hub:latest`

### 部署（服务器 / 用户）
```bash
docker compose up -d          # 首次启动
```
- 访问 `http://服务器IP:3001`。
- 首次启动后进入「设置」页填写 Mikan / BGM / qBittorrent 配置；配置写入卷内 `config.json`。

### 在线升级（保留配置与数据）
```bash
# 推荐：一键脚本（自动备份配置 → 拉镜像 → 重建）
./deploy/upgrade.sh

# 或手动
docker compose pull
docker compose up -d --force-recreate
```
- 数据卷 `soraika-data` 映射到容器 `/data`，里面存 `config.json` 与数据库。
- **升级只替换镜像，卷不动 → 配置与数据库不丢。**

### 备份 / 恢复
```bash
# 备份卷（先停容器避免写冲突）
docker compose stop
docker run --rm -v soraika-data:/data -v "$PWD/backup":/backup alpine \
  tar czf /backup/soraika-data.tar.gz -C /data .
docker compose start

# 恢复
docker compose stop
docker run --rm -v soraika-data:/data -v "$PWD/backup":/backup alpine \
  tar xzf /backup/soraika-data.tar.gz -C /data
docker compose start
```

### 脱敏红线（公开仓库 / 公开镜像必读）
- `.gitignore` 已排除 `server/config.json`；`.dockerignore` 已排除 `server/config.json` 与 `server/data/`。
- 镜像**不含任何用户配置与真实密钥**，首次使用需挂卷 + 在设置页填写。
- 推送公开前自查 git 历史是否泄露过 config：
  ```bash
  git log --all --oneline -- server/config.json
  ```
  如有记录，需用 `git filter-repo` 重写历史后再公开（会改 commit 哈希）。
- Dockerfile / compose 中**不得写死** token、密码等敏感值。

## 十一、对 AI 的规范（协作要求）

> 用户与 AI 协作时必须遵守的硬性约定。

- **同步更新 README**：凡涉及设计、动画、交互、系统级、后端接口等要求，AI 必须同步写入本 README 对应章节，保持规范一致。
- **图标一律用图标库组件**：业务/交互用 `@tabler/icons-vue`，侧边栏用 `@phosphor-icons/vue`；禁止在代码里写 emoji 或乱码字符当图标。
- **用户举例仅供参考，必须独立思考**：用户给出的配色、方案、尺寸等举例不能不加思考照搬，AI 须先说明设计理由再定稿，避免"把示例当需求"。
- **改完必须验证**：前端改动需跑 `vite build` 确认通过；后端改动需 `node --check` 校验语法，不得只改不验。
- **修 bug 要定位根因**：遇到 bug 先定位根因并在回复里说明，不得只改表象敷衍。
- **信息不重复**：导航/引导栏已展示的信息（当前模块名、星期），不要在紧邻内容区重复展示。
- **配色同色系渐进**：多模块用同色系（暖金→暖红）低饱和渐进，不做割裂的"阵营色"，避免"给番剧分三六九等"观感。
- **导航固定不浮动**：实色背景 + 顶部锚定，不做半透明毛玻璃 + 负 margin 悬浮卡片质感。
- **海报必须干净**：标签/评分不得覆盖在海报上。
- **卡片标签宁短勿长**：三级信息优先省略或换行，不硬塞长名词。

---

## 十二、ID 命名规范（mikanId / bgmId / subjectId）

> 全端字段统一，杜绝"同名不同义"的混淆。

| 统一字段 | 含义 | 出现位置 |
|---|---|---|
| `mikanId` | Mikan 番剧 ID（`/Home/Bangumi/{mikanId}`） | 首页排期、`parser.js` 返回、QB 任务名首字段、转换表 key、`/subdetail` 响应的 `mikanId` |
| `bgmId` | Bangumi 条目 ID（`bgm.tv/subject/{bgmId}`） | 发现页卡片、候选池 key、转换表 value、AnimeCard 外链、DB `bgm_id` |
| `subjectId` | 详情面板（AnimeDetailPanel）入参，兼容 Mikan/BGM 两种 ID | 首页/发现页传给面板的 prop；服务端 `/subdetail/:id` 自动解析 |

- **下载任务名 `taskName` 首字段统一为 `mikanId`**：无论从首页还是发现页发起下载，任务名第一个字段都是 Mikan ID，保证下载页分组/海报/字幕组关联一致。
- 服务端转换：`mikanMapping.lookupMikanId(任意ID)` → Mikan ID；`lookupBgmId(mikanId)` → BGM ID。
- 首页排期补评分必须**先转换**（`lookupBgmId(mikanId)` → `getSubjectMeta(bgmId)`），不得直接用 Mikan ID 查 BGM 候选池。

## 十三、下载页设计规范

- **布局**：海报卡片网格（复用 `AnimeCard`），与首页/发现页一致；顶部**季度（SE）筛选标签栏**，点击快速筛选。
- **分组**：按 `mikanId` 合并，同一番剧跨季归一张卡；卡片 badge 显示完成度（`已完成` / `x/y`），底部 meta 显示季范围（`SE01-SE02`）+ 已下载字幕组。
- **综合侧边栏（`DownloadDetailPanel`）**：
  - 上半部分：海报、番名、SE、**已下载字幕组** + BGM 评分/简介/标签
  - 下半部分：**已下载集管理**，样式对齐详情面板的 TorrentList（左侧大号斜体集数 + 右侧内容/进度条/大小/删除/重命名）
  - **筛选标签栏**：字幕组 + 季度（SE）双维度筛选，样式与详情面板资源筛选一致
- **字幕组显示规则**：只显示"**实际已下载的字幕组**"（来自任务名解析 `subgroupName`），不罗列番剧的全部字幕组。

#### 资源卡片（下载侧边栏·已下载集）
- **结构（div 分层）**：`res-num`（集数徽标）｜ `res-info`（`res-label` 集数 + `res-meta` 大小/字幕组辅助行）｜ `res-action`（完成 ✓ / 进度环 + 操作菜单）
- **集数徽标**：左侧 52px，暖金色半透明底 + 金色大号斜体数字（Georgia serif）
- **主信息**：`S01E04`（accent 加粗），一行定位
- **辅助信息（弱化）**：大小、字幕组为**灰色小字**（`--text-secondary`），无彩色；字幕组超长 `word-break` 完整显示
- **右侧交互**：
  - 完成态显示**绿色 ✓ 圈**（`#22c55e`），**hover 变编辑图标 ✎**（accent）
  - 下载中显示 SVG 圆形进度环 + 百分比（颜色随状态：下载中蓝/卡住橙/暂停灰/错误红）
  - **点击 ✓ / 进度环 → 在卡片（海报区域）旁浮出「任务配置弹窗」**：任务名输入框（预填当前名）+ **保存**（重命名）+ **删除**（红色，点击后再确认一次防误删）；弹窗为表单结构，**后期可扩展其他配置项**；点击面板其他区域 / Esc 关闭
- **深色适配**：一律走 CSS 变量（`--bg-card`/`--bg-input`/`--bg-dropdown`/`--text-*`/`--border`），禁止硬编码浅色
