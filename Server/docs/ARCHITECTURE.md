# Soraika Hub —— 架构与实施方案

> 一句话：把「这季有什么番 / 评分多少 / 同一系列还有哪几季 / 哪个字幕组发了哪些集」
> 做成**只读库就能回答**的数据；前端只负责摆，不做业务、不做格式化。
>
> 配套文档：`Server/CONVENTIONS.md`（后端开发约定，§ 编号在本文里被大量引用）、
> `Web/CONVENTIONS.md`（界面与交互约定）、`Server/docs/MCP.md`（对外 AI 协议）、
> `Server/docs/TODO.md`（当前待办）。

---

## 0. 三条铁律（所有取舍都源于此）

| # | 铁律 | 落地方式 |
|---|---|---|
| 1 | **能确定的绝不问 AI** | 集号 / 修订版号 / 系列链序 / 字幕组归属 = 规则或确定性匹配；AI 只做「抽取与归一」 |
| 2 | **不依赖需要梯子的站点** | BGM 走镜像 `bgmapi.anibt.net`，不用 `bgm.tv/.../relations/graph` |
| 3 | **只读库就能回答** | 快路径全部走本地 SQLite；上游只做「后台补齐」与「现取兜底」 |

---

## 1. 总体架构

```
                     ┌──────────────── Web (Vue 3 + Vite) ────────────────┐
                     │ pages/        只摆（Home / Discover / Settings）     │
                     │ components/   纯展示（PosterCard / DetailPanel …）   │
                     │ composables/  取数 + 状态机（唯一有逻辑的地方）      │
                     │ api/          只有 fetch 封装（同源 /api）           │
                     └───────────────────────┬────────────────────────────┘
                                             │ HTTP（JSON 信封 { ok, data })
┌──────────────────────────────── Server (Express) ────────────────────────┐
│ rout/        只拼装：校验参数 → 调 api/ → 包信封                          │
│ api/pages    编排：定优先级（库 → 缓存 → 上游）、拼成品字符串             │
│ api/sources  数据源适配：mikan / bgm / ai（超时、重试、字段归一）         │
│ clients/     最底层抓取与解析：Mikan.js（cheerio）/ Qb.js                 │
│ db/          SQLite：anime / subgroup / settings + queue（队列策略）      │
│ lib/         纯函数：format / season / series / release-match / settings  │
│ cache/       进程内缓存（按 TTL + 内容哈希）+ 海报落盘（poster）          │
│ jobs/        worker（3 触发）/ enrich / series / sweep-mikan              │
└──────────────────────────────────────────────────────────────────────────┘
```

**依赖方向（单向，不许反向）**：`rout → api → (db | sources | clients) → lib`；
`jobs` 与 `api` 平行，都建在 `db + lib` 之上（CONVENTIONS §1）。

### 一次「点海报」的数据流

```
点卡片 → useAnimeDetail.open(id)        ← 立刻 data=null + loading（骨架屏就地替换）
       → GET /api/anime/:id             ← 纯读库；缺字段才现场 enrichOne 一次（5 分钟防抖）
       → 面板渲染（评分 / 标签 / 简介 / 外链）
       → GET /api/anime/:id/series      ← 没算过就现场走一次关系链
       → GET /api/anime/:id/subgroups   ← 每次直连 Mikan 详情页（不缓存、不落库）
       → GET /api/anime/:id/releases?subgroupId=<rssId>
                                        ← <100 条直接用；=100 条 → 全量 feed + 格式特征认领
```

---

## 2. 数据模型

### 2.1 `anime`（唯一的主表，28 列，按用途分组）

| 组 | 列 | 谁写 |
|---|---|---|
| 身份 | `id`(PK) / `mikan_id` / `bgm_id` / `title` / `title_cn` | 扫描 / 排期 / 补齐 |
| 海报 | `poster_src`（图源 URL）/ `poster_path`（本地缓存文件名） | 出图接口 / 后台预热 |
| 档案 | `score` `rating_total` `tags` `watching` `summary` `total_episodes` `air_date` | BGM |
| 排期 | `year` `season` `weekday` | **只有 Mikan 排期页写**（§10.3） |
| 补齐簿记 | `bgm_checked_at`（上次刷档案）/ `bgm_miss_count` | worker |
| 系列 | `series_id` `series_index` `series_relation` `naming_style` `series_root_title` `series_checked_at` | `jobs/series.js` |

**关键不变式**

- 扫描进来的行：只有 `mikan_id` + `bgm_id` + `title`；**排期字段一律留空**（否则混进排期），
  **`bgm_checked_at` 也留空**（否则被档案补齐的退避窗口挡住 7 天）
- 系列字段只给**已在库**的作品写；根名 / 命名风格**只写在代表行**（`series_id = id` 的那行）
- 合并一律 COALESCE：**这次没拿到的字段不覆盖已有值**；唯一的反向是 `poster_src`（已有值优先）

### 2.2 `subgroup`（纯名字字典，不存关系）

`id / mikan_subgroup_id(唯一) / name / rss_id(仅参考) / source / created_at / updated_at`

> 「哪个作品有哪些组 + **该作品下的 rss id**」**不落库** —— 每次现取（见 §7-14/15）。
> 留这张表只为「拿到 mikan_subgroup_id 能显示名字」，随用随建。

### 2.3 `settings`（key → `value_json`）

只存**设置页改过的项**（当前 25 项）；没改过的一律吃代码默认值（CONVENTIONS §6）。

---

## 3. 数据来源与抓取策略

| 源 | 用途 | 端点 | 坑（全部实测） |
|---|---|---|---|
| **Mikan** | 排期主源（星期/番名/封面/mikanId） | `/Home/BangumiCoverFlowByDayOfWeek?year=&seasonStr=` | 必须带 UA，否则回 **200 空壳页**（"偶发失败"的真因） |
| | 权威 `bgmId` + 字幕组列表 | `/Home/Bangumi/{mikanId}` | 老番常常确实没挂 BGM 链接（正常情况，不是错误） |
| | 资源列表 | `/RSS/Bangumi?bangumiId=&subgroupid=` | **带 subgroupid 只给最近 100 条**；不带才是完整历史 |
| **BGM 镜像** | 评分/人数/标签/简介/集数/放送日 | `/v0/subjects/{id}` | 需要 UA（配 token 可提高额度） |
| | 1 跳关系（系列链） | `/v0/subjects/{id}/subjects` | 关系是「相对当前条目」的；剧场版也可能挂在「续集」边上 |
| **AI**（可选） | 资源标签 / 集数 / 系列归一 / 格式特征 | OpenAI 兼容 `/chat/completions` | 没配 key = **未配置**（501），不是失败 |

**统一入口**：`lib/http-client.js`（超时 + 指数退避重试 + 4xx 不重试）。
Mikan 额外一层 **解析级重试**：200 但连标题都解析不出来 = 空壳页 → 重试（`api/sources/mikan.js`）。

---

## 4. 后台任务：3 个触发 / 4 条队列

`jobs/worker.js` 每轮**各推进一条**（防止长队列把短队列饿死）：

| # | 队列 | 谓词 | 处理 | 退出 / 退避 |
|---|---|---|---|---|
| ①a | 补齐（缺 bgmId） | `mikan_id IS NOT NULL AND bgm_id IS NULL` | Mikan 详情页 → BGM 条目 | 没链接/404 → `bgm_miss_count++`；超 `missLimit` 后隔 `missRetryHours`(7d) 再试 |
| ①b | **档案补齐** | `bgm_id IS NOT NULL AND (score/tags/summary 任一为空)` | **跳过 Mikan**，只打 BGM 一次 | 补过仍缺 → 隔 7d 再试 |
| ② | 每日更新 | `bgm_id IS NOT NULL AND year = 当年 AND bgm_checked_at < 最近一次到点时刻` | 重刷整份档案 | 固定时刻（默认 04:00）；不设配额（公式自带限流） |
| ③ | 系列补齐 | `bgm_id IS NOT NULL AND series_checked_at IS NULL` | 走链 + AI 归一 + 落库 | 失败/未配 AI → 放回 `NULL`；worker 侧连续失败指数冷却（≤10min） |

**队列七条规范（CONVENTIONS §5）的落点**

- **认领**：全部 CAS（`UPDATE ... WHERE id = ? AND <标记> IS ?`，`changes===1` 才算抢到）；
  系列队列用 `series_checked_at = -1` 当"处理中"哨兵（不用加列）
- **恢复**：worker 启动时 `resetStaleSeriesClaims()` 把上次崩在中间的 `-1` 清回 `NULL`
- **可观测**：`/api/health` 的 `worker` 段（pending / gaveUp / archivePending / seriesPending / lastError）
- **自愈**：`runLoop` 兜住任何异常（记 `lastError` + 清残留认领 + 退避重进）——
  一次上游 404 曾把整个守护进程打死

**一次性任务（CLI）**：`npm run sweep`（Mikan→BGM 全量扫描）/ `enrich` / `backfill` / `series`

---

## 5. API 契约（全部 19 个端点）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活 + 覆盖率 + 各队列进度 + AI 状态（**不含密钥**） |
| GET | `/api/home/schedule?year=&season=&force=` | 首页排期（库优先，10 分钟 TTL，`force=1` 强刷） |
| GET | `/api/anime/:id` | 详情（缺字段现场补一次，5 分钟防抖） |
| GET | `/api/anime/:id/series` | 同系列（没算过就现场走链；单成员返回 `null`） |
| GET | `/api/anime/:id/subgroups` | 字幕组（**每次直连 Mikan**，`id` = 该作品下的 rss id） |
| GET | `/api/anime/:id/releases?subgroupId=` | 资源列表（`all` = 全量 feed） |
| GET | `/api/img/anime/:id` | 出图（本地缓存 → `poster_src` → 问 BGM → 抓不到 302 交浏览器） |
| GET | `/api/ai/tools` `/api/ai/models` | MCP `tools/list` 形状 / 模型列表 |
| POST | `/api/ai/call` | MCP `tools/call` 形状（统一入口） |
| POST | `/api/ai/classify/tags` `/api/ai/classify/episodes` | 便利直连（前端用） |
| GET / PUT | `/api/settings` | 读 / 批量改（非法值整批拒绝） |
| POST | `/api/settings/reset` `/import` `/test` | 重置 / 导入 / 连通测试（**唯一对外发请求的 settings 接口**） |
| GET | `/api/settings/export?secrets=1` | 导出（默认脱敏） |

**信封**：成功 `{ ok: true, data }`；失败 `{ ok: false, error: { code, message, detail } }`。
错误码只用：`BAD_REQUEST / NOT_FOUND / INTERNAL / UPSTREAM / PARSE / NETWORK / AI_DISABLED`。

---

## 6. 前端架构

**分层**：`pages`（怎么摆）→ `composables`（取数 + 状态机，**唯一有逻辑的地方**）→ `api`（只 fetch）。
容器只有一个：`App.vue`（面板状态、排期状态都装在这里，所以"全站一个面板"）。

| composable | 职责 | 关键设计 |
|---|---|---|
| `useSchedule` | 首页排期 + 季切换 | 请求序号作废旧响应；`localStorage` 记住上次的季 |
| `useAnimeDetail` | 面板开关 + 三态 | 换作品**立刻** `data=null + loading`；loading 最短 180ms（否则只闪一帧） |
| `useSeries` | 系列 chip 数据 | **失败不报错**（附加信息，取不到就当没有） |
| `useReleases` | 字幕组 → 资源列表 | 切组清勾选 |
| `useAiTags` / `useEpisodes` | AI 标签 / 集数 | 按「字幕组 + 这一批」缓存；`merge` 累加（"显示更多"不重来、不重复花钱） |
| `useSettings` / `useTheme` / `useScrollSpy` | 设置草稿 / 主题 / 吸顶高亮 | — |

**资源列表（面板里最复杂的一块）**

- **分页**：`PAGE_SIZE = 120` = 面板 `AI_BATCH`（展示多少就解析多少，不提前花钱）
- **排序**：**总是**排 —— ① 集号大的在前 ② 同集按命中标签数 ③ 再同保持上游顺序；
  认不出集号 / 合集 / 特典 → 沉底
- **换作品动效**：**骨架屏就地替换**（`DetailSkeleton`）—— 不整块转圈、不整块淡入、不残留旧内容

---

## 7. 关键决策（决策 / 为什么 / 实测证据）

| # | 决策 | 为什么 / 证据 |
|---|---|---|
| 1 | 排期主源 = Mikan，评分源 = BGM | Mikan 一页给全「星期 + 番名 + 封面 + id」；BGM 才有评分/标签 |
| 2 | 权威映射只认 Mikan 详情页的 BGM 链接 | 标题猜匹配必错（长寿番 / 译名不一）；实测 5400 id → 3233 映射、失败 1 |
| 3 | BGM 走镜像 api，不用 `relations/graph` | graph 需要梯子 |
| 4 | 系列链只沿 `续集/前传` 且 `type=2` | 否则顺「联动」跑到《王者荣耀》《堡垒之夜》 |
| 5 | 番外只收**白名单**（番外篇/总集篇/剧场版） | 「角色出演」是交叉作品，会把两个系列搅成一个（异世界四重奏 ↔ OVERLORD） |
| 6 | 链序由链位给，不看名字/年份/id | BGM 上第一季名字里没有「S1」 |
| 7 | 走链要**补反向指针** | 关系常是单向的，不补链序从中间断开（石纪元 7,8,1,2,3… → 1..9） |
| 8 | 剧场版/总集篇/OVA **按名字**判、不给季位 | BGM 把剧场版挂在「续集」边上（妄想学生会 S03/S04 事故）；仍照常穿过它，否则后面的季走不到 |
| 9 | `series_id` 首写优先 | 交叉作品会把两边的成员互相覆盖成混合态 |
| 10 | 系列懒加载：看哪部算哪部 + 后台补齐 | 3200 部全算要几小时；用户没看的不用先算 |
| 11 | 图源三级链 + 直链优先 + 后台预热 | 81% 的行只有 `bgm_id` 没封面；直链让浏览器立刻显示，预热把图存本地 |
| 12 | 缓存文件名用**地址哈希** | 用自增 id 换个库就成孤儿（实测 469 条里 313 条） |
| 13 | 回源失败 **302 交浏览器** | 防盗链/图床挂时前端绝不空着 |
| 14 | 字幕组**不落库**（映射现取） | Mikan 详情页一页就带「组 + 各自的 rss id」；同一个组在不同作品下 rss id 不同（37 / 488 / 422） |
| 15 | 资源列表：`<100` 直接用、`=100` 全量 + 特征认领 | 单组 feed 只给 100 条；黑叶草 100 条（77~161 集）→ 266 条（1~169 集） |
| 16 | 格式特征 **AI 只抽、判断靠确定性匹配** | 逐条问模型太贵；特征是"组的身份"，匹配是纯函数（可测、免费） |
| 17 | 配置只有两层：代码默认值 → 设置页 | `.env` 只剩 `PORT / DB_FILE / LOG_LEVEL`；导出/导入能带走整份配置 |
| 18 | AI 没配 = **未配置**（501），不是失败 | 前端显示「未配置」，不该显示「重试」 |

---

## 8. 踩过的坑（现象 → 根因 → 现在怎么防）

| 现象 | 根因 | 现在的防法 |
|---|---|---|
| 后台"在跑"但队列不动 | 上游 404 抛穿 loop，进程静默退出 | 三层兜：源层 404→`[]`、job 层全包 try、worker `runLoop` 自愈 |
| 系列混成 15 部假系列 | 交叉作品互相当番外写 | 番外白名单 + `series_id` 首写优先 |
| 剧场版拿到 S03/S04 | BGM 把剧场版标成「续集」 | 按名字判非正传、不给季位 |
| 长系列季号错乱 | 关系单向 → 中间节点被当链头 | 建节点时补反向指针 |
| 老番没评分/标签 | 扫描行 `bgm_id` 有、字段空，两条老队列都够不着 | 新增 ①b「档案补齐」；扫描行不再写 `bgm_checked_at` |
| 八成作品没海报 | 只在有 `poster_src` 时给地址 | 三级链 + 直链 + 后台预热 |
| 字幕组"偶发"读不到 | 不带 UA 被当爬虫（200 空壳页） | 带 UA + 指数退避 + **解析级重试** |
| 单组资源只有 100 条 | Mikan 单组 feed 上限 | 全量 feed + 格式特征认领 |
| 「显示更多」白点 | watch 依赖里带了筛选条件 | 只依赖 `items`；`limit` 只在变大时通知 |
| 资源列表看着乱 | 只在筛选时才排序 | 总是按集号排 |
| 点海报还显示上一部 | 三态挤在 `out-in` 过渡里（旧的先淡出） | 骨架屏就地替换，无整块过渡、无分支 key |

---

## 9. 验证体系（改动必须能验收）

| 脚本 | 钉什么 |
|---|---|
| `Server/scripts/verify-home.mjs` | 首页契约：字段/文案/缓存/出图/海报三级链/预热/优雅停机 |
| `verify-detail.mjs` | 详情 + 系列（含名字判定）+ 字幕组 + 资源 + 表结构不变式 |
| `verify-ai.mjs` | 工具清单、入参校验、未配置降级、**全量分批**、缓存命中 |
| `verify-settings.mjs` | 字段清单、校验、密钥打码、导出导入、连通测试、重置 |
| `verify-worker.mjs` | 队列谓词与计数一致、认领 CAS、系列队列不丢任务 |
| `Web/scripts/verify-e2e.mjs` | 真数据渲染 + 面板三态 + 骨架屏 + 排序/分页 + 各组件结构断言 |

约定（CONVENTIONS §8 / Web §14）：**每处改动都在对应 verify 里加断言**；
临时脚本 `tmp-*.mjs` 用完即删（两边 `.gitignore` 已忽略）。

---

## 10. 路线图

**P0 · 数据完整性**
- [x] Mikan↔BGM 映射全量（3233 / 3237）
- [x] 档案补齐（评分/标签/简介）—— `needArchive 2769 → 860`（后台在跑）
- [ ] **老番字幕组补齐**：档案补齐对「已有 bgmId」的行跳过 Mikan → 老番资源区仍是空的 ⚠️
      （方案：给 ①b 加一个「顺便抓字幕组」开关，或单开一条只补字幕组的队列）

**P1 · AI v9（一次调用三类产物）**
- [ ] 标签 + 集数 + **格式特征**合并成一次调用（省一半调用量）
- [ ] 缓存 key 加 **prompt 内容 hash + model**（换模型/改提示词不再命中旧结果）
- [ ] 修四处"对不上"：`season` 没传、`AI_TOOLS` schema 缺参、
      `TYPE_ORDER` 与 `'version'` 不一致、`VALID_TYPES` 漏音频类

**P2 · 下载闭环**
- [ ] `qb` 接入：选中资源 → 加种 → 进度 → 归档目录（`{根名}/S01/…`，规则见 §10.5）
- [ ] 下载页：按季 / 按系列列"已下 / 缺哪集"

**P3 · 体验**
- [ ] 搜索页（复用 `useAnimeDetail` 打开面板）
- [ ] 接 `vue-router` 替换现在「侧栏 key → 组件」的临时映射

---

## 11. 目录地图

```
Server/
  src/
    config.js                 ← 代码默认值（env 只剩 PORT / DB_FILE / LOG_LEVEL）
    rout/                     ← 只拼装（home / anime / ai / settings / img / health）
    api/
      pages/                  ← 编排（home / anime / ai / settings）
      sources/                ← 数据源适配（mikan / bgm / ai）
      mappers/                ← 行 → DTO（成品字符串在这里拼）
      ai-tools.js             ← AI_TOOLS + callAiTool（MCP 形状）
    clients/                  ← Mikan.js / Qb.js（抓取 + cheerio 解析）
    db/                       ← index.js（连接+迁移）/ schema.sql / anime.js / queue.js / settings.js
    lib/                      ← format / season / series / release-match / settings / http-client / errors / logger
    cache/                    ← mem.js（TTL + 内容哈希）/ poster.js（海报落盘）
    jobs/                     ← worker.js（3 触发）/ enrich.js / series.js / sweep-mikan.js
  scripts/                    ← verify-*.mjs（6 个验收）+ tmp-*.mjs（用完即删）
  docs/                       ← ARCHITECTURE.md（本文）/ TODO.md / MCP.md

Web/
  src/
    App.vue                   ← 唯一容器（面板状态装这里）
    pages/                    ← HomePage / DiscoverPage / SettingsPage
    components/
      common/                 ← PosterCard / PosterImage / CardGrid / SeasonPicker / MetroNav / SearchBox
      detail/                 ← AnimeDetailPanel / DetailSkeleton / SubgroupBar / AiSlot / ReleaseList
      settings/ ui/ layout/   ← FieldControl / PopoverPanel / StateBlock / Spinner / AppSideNav …
    composables/              ← useSchedule / useAnimeDetail / useSeries / useReleases
                                useAiTags / useEpisodes / useSettings / useTheme / useScrollSpy
    api/                      ← 只 fetch（http / home / anime / ai / settings）
    utils/                    ← episode / duration / season / weekOrder / orderKey
  scripts/verify-e2e.mjs
```

---

## 附 · 数据快照（2026-10 的验收口径）

```
anime        3247 行（withBgm 3240 / withScore 2460↑ / needArchive 860↓）
系列          算过 3205 · 多成员系列 58 个（光之美少女 17 / 暗芝居 16 / 柯南 9 …）
映射          3233 个 bgmId（扫描 5400 个 id，失败 1）
字幕组字典    37 行（随用随建，不存关系）
Mikan 资源    单组 ≤100 条；全量 369 条（黑叶草 1~169 集，认领后单组 266 条）
```





