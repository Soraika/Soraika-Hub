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
| **AI**（可选） | 资源标签 / 集数 / 系列归一 / 格式特征 / **组标记→组名映射** | OpenAI 兼容 `/chat/completions` | 没配 key = **未配置**（501），不是失败；逐条归类不做 AI（改用组标记确定性匹配） |

**统一入口**：`lib/http-client.js`（超时 + 指数退避重试 + 4xx 不重试）。
Mikan 额外一层 **解析级重试**：200 但连标题都解析不出来 = 空壳页 → 重试（`api/sources/mikan.js`）。

**多源与故障切换**（`lib/multi-source.js`）：`config.mikan.bases` / `config.bgm.bases` 是**有序候选**，
逐个尝试、记住上次成功的那个；全部失败才抛错（抛第一个错误，语义最接近"这次真的没拿到"）。
外链与 `poster_src` 固定用**第一个**地址 —— 链接要稳定，不能跟着健康检查漂移。

---

## 4. 后台任务：3 个触发 / 4 条队列

`jobs/worker.js` 每轮**各推进一条**（防止长队列把短队列饿死）：

| # | 队列 | 谓词 | 处理 | 退出 / 退避 |
|---|---|---|---|---|
| ①a | 补齐（缺 bgmId） | `mikan_id IS NOT NULL AND bgm_id IS NULL` | Mikan 详情页 → BGM 条目 | 没链接/404 → `bgm_miss_count++`；超 `missLimit` 后隔 `missRetryMs`(7d) 再试 |
| ①b | **档案补齐** | `bgm_id IS NOT NULL AND (score/tags/summary 任一为空)` | 打 BGM 一次；`worker.fetchSubgroups`（**默认开**）时**顺带抓一次 Mikan 详情页**，把字幕组记进名字字典（老番的资源区靠它） | 补过仍缺 → 隔 7d 再试；字幕组抓失败只 warn，不影响档案 |
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
| GET | `/api/anime/:id/subgroups` | 字幕组（**每次直连 Mikan**，`id` = 该作品下的 rss id；**详情页 404 时退化成一个「全部字幕组」**） |
| GET | `/api/anime/:id/releases?subgroupId=` | 资源列表（`all` = 全量 feed） |
| GET | `/api/img/anime/:id` | 出图（本地缓存 → `poster_src` → 问 BGM → 抓不到 302 交浏览器） |
| GET | `/api/ai/tools` `/api/ai/models` `/api/ai/providers` | MCP `tools/list` 形状 / 某地址的模型列表（`?baseUrl=` 可传未保存的） / 供应商目录（models.dev） |
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
| 19 | **以 Mikan 有的资源为准**：详情页 404 时退化成一个「全部字幕组」 | 老番的详情页会被 Mikan 拿掉，但**资源 feed 还活着**。全库实测 **7 条**详情页 404（跨 2016 春 / 2021 夏 / 2023 春 / 2023 秋），**7/7 都有 RSS 资源**（最少 11 条、最多 514 条）；不退化的话这些番的资源区永远是空的 |
| 20 | **详情页 404 时用「组标记 × 库里组名」得出字幕组**，不摆假的「全部」 | 老番拿不到详情页就没有官方组列表，但文件名开头的方括号几乎都是组标记（`【幻樱字幕组】`/`[c.c动漫]`）。做法：**组标记去重 + 库里组名表 → 一次小额 AI 映射**，逐条归类用确定性前缀匹配（零额外 token）。实测：久保同学不放过我 → 6 个真组（`喵萌奶茶屋` 63 条）、龙珠超 → 6 个真组（`幻樱字幕组` 258 条），耗时 ~2s；假组（番名/平台/`修正`）被「AI 对不上就丢 + 出现≥2 次」两道过滤清掉 |
| 21 | **Mikan / Bangumi 都支持多地址**（`mikan.bases` / `bgm.bases`） | 写死一个域名等于把可用性押在它身上（会换域名、会抽风）。做法：有序候选 + 记住上次成功的那个；外链只认第一个地址（链接不能漂）。设置页是多行文本（一行一个），校验时「有一条不合法就整批拒绝」 |
| 22 | **所有时长项统一存毫秒（`*Ms`），界面统一 `formatDuration`** | 旧设计里 `missRetryHours`（小时）、`image.maxAgeSec`（秒）是例外，正是"24 小时显示成 24ms"的来源。现在显示一律 `350ms` / `30s` / `1m 30s` / `7d` / `1d 12h`（最多两级单位），并且从**毫秒往上**换算，不再出现小数点（`1.5s` → `1s 500ms`） |
| 23 | **AI 测试 = 真发一次对话并校验约定标记** | 只看 200 / `/models` 是假成功（地址对但 Key 错、模型名不存在都算"通"）。现在让模型只回 `SORAOK`，**收到这个词**才算通 —— 连带验证出网、Key、模型名与"会不会听指令" |
| 24 | **供应商清单取自社区维护的 models.dev**，代码里不手写 | 模型/供应商几个月换一批，手写必然过期。`/api/ai/providers` 拉 models.dev（199 家可用，含国内几家），只收 `npm` 是 `@ai-sdk/openai(-compatible)` 且有 `api` 的（其它走不了 `/chat/completions`）；带各自模型名，**没填 Key 也能先给候选**；缓存 24h，取不到退回内置 20 家 |
| 25 | **时长是「多列滚轮」，不是输入框** | 时长的量级从 350ms 到 7 天，让用户心算毫秒或敲 `1m 30s` 都是在跟机器较劲。列按量级自动选（`s·ms` / `m·s` / `h·m` / `d·h·m`），滚动停下后按各列求和换算成毫秒；行内仍显示 `7d` / `1m 30s` |
| 26 | **多源地址是「可拖拽的有序列表」，不是多行文本** | 顺序本身就是配置（排在前面的先用）→ 必须能拖、能上下移；每条都可能独自坏掉 → 每条单独测 + 一键全测（`SourceListEditor`）。存库仍是换行文本，线上格式没变 |
| 27 | **数据源地址属于「基础配置」** | Mikan / Bangumi 的地址不填就用不了（信息从哪来），所以 `mikan.bases` / `bgm.bases` 都在基础层；只有 Token、UA、落盘目录这类可选项才收进微调参数 |
| 28 | **AI 配的是「提供商」，不是 URL（「自定义」只是下拉里的一个选项）** | 使用者脑子里是"用哪家"。下拉 = models.dev 目录 + 最后一行「自定义」：选目录里的 → 自动填 `ai.baseUrl` 并按那家的模型列表补齐 `ai.model`；选「自定义」→ 只记名字，地址由使用者自己写（`ai.baseUrl` 常显在「接口地址」小节）。**不做"存一串自定义提供商"的二级结构** —— 那是我第一版想复杂了 |
| 29 | **设置页只留"旋钮"，护栏不进设置** | `worker.staleYear`（覆盖年份）和 `seasonLimit`（单季入库上限）已从设置页删除：前者与"每日更新只刷当年"的语义冲突，后者是防异常数据的代码护栏 —— 放出来只会让人以为"调小能少缓存" |
| 30 | **AI 一次调用拿三类产物**（`BUNDLE_SYSTEM_PROMPT` v7） | 标签 + 番名/季 + 集数原本是 2 次独立调用，token 与延迟都翻倍，而且两次看到的上下文不同（季数会对不上）。现在一次 prompt 全给，两个入口共用同一份缓存 —— 实测「先标签后集数」第二次 **3ms 命中**（省掉一次调用） |
| 31 | **多源默认只配一个地址** | `mikanani.me` 实测完全不响应（8s 超时）：把它当"备用"的代价是主站每抖一次就多等 20s，表现成"首页切季一直转圈/打不开"。默认只留 `mikanime.tv`，启动时还会把旧配置里的 `mikanani.me` 摘掉 |
| 32 | **链上缺的环节建「骨架行」，季位连续编号 + 只填不改** | 系列成员原本只写「已在库」的行 → 缺了第一季时季位整体前移（实测《死神 千年血战篇》前传是 2004 年《BLEACH》，Mikan 赛季页对 2004 返回空壳扫不到 → 用户看到"没有 S1"）。现在走链时给链上缺的**正传**补一行只有 `bgm_id` + 名字的骨架（不进排期、会被档案队列自动补评分、资源区自然为空），单趟最多 20 个；季位按**真正写进库的成员**连续编号（补不出来就不占位）。写入是 **COALESCE（只填不改）** + `(series_id, series_index)` **部分唯一索引**：同一个系列可能被两条不同的链写（《我的英雄学院》剧场版互连、TV 互连），谁先算出来算谁的，永不出现「两个 index=1」。需要整体重排时（链上补进了新头部）走一次性修复：清空该系列的系列字段让它重算。实测：重排 190 个系列后《死神》S01~S05、`我的英雄学院` TV 占 S01~S05、剧场版归番外，不变量「缺头部 0 / 缺环 0 / 重复季位 0」 |

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
| worker 失败计数被刷满（processed 9 / failed 9） | 死 mikanId 的详情页 404 被当成"失败"，不计放弃 → 永远每分钟重试 | Mikan 404 视同「上游确实没有」→ 走放弃/退避（`missLimit` 后退出队列） |
| 老番资源区永远是空的 | 详情页被 Mikan 拿掉（季度列表还在，`/Home/Bangumi/{id}` 404）→ 拿不到字幕组，链路断在第一步 | 详情页 404 → 给一个「全部字幕组」→ 全量 feed 照样取资源（**Mikan 有资源就以它为**） |

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
- [x] **老番字幕组补齐**：①b 加 `worker.fetchSubgroups`（默认开）→ 顺带抓一次 Mikan 详情页
      把字幕组记进名字字典（实测字典 37 → 62 条）

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





