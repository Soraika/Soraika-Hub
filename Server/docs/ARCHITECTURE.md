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

> **下一步的结构改造见 `docs/SCHEMA-V2.md`**（设计稿，未实施）：把现在混在一张 `anime` 里的
> 「身份映射 / BGM 档案 / Mikan 排期」拆成三张表，重建排期不影响映射。

### 2.1 `anime`（唯一的主表，28 列，按用途分组）

| 组 | 列 | 谁写 |
|---|---|---|
| 身份 | `id`(PK) / `mikan_id` / `bgm_id` / `title_mikan` | 扫描 / 排期 / 补齐 |
| 海报 | `poster_src`（图源 URL）/ `poster_path`（本地缓存文件名） | 出图接口 / 后台预热 |
| 排期 | `year` `season` `weekday` | **只有 Mikan 排期页写**（§10.3） |
| 补齐簿记 | `bgm_checked_at`（上次刷档案的时间） | worker |
| 系列 | `series_id` `series_index` `series_relation` `naming_style` `series_root_title` `series_checked_at` | `jobs/series.js` |

> **档案不在这张表**：评分/标签/简介/放送日/集数/平台/原名在 `bgm_subject`（见 §2.4），
> 身份映射在 `mikan_bgm_map`（§2.3）。读取统一走视图 `v_anime`（排期 LEFT JOIN 档案）。

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
| **BGM 离线 dump** | **批量**刷新以上档案（本地 1.3GB jsonlines，一条请求都不发） | `github.com/bangumi/Archive` releases（`aux/latest.json` 给最新地址，每周三 05:00 GMT+8） | 只有 wiki 原文，**没有封面**；`total_episodes` 要自己数 `type=0` 的章节；索引与下载都多源（镜像 + 断点续传） |
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

**一次性任务（CLI）**：`npm run sweep`（Mikan→BGM 全量扫描）/ `enrich` / `backfill` / `series` / `archive`（手动导入 dump）/ `dump`（检查 + 自动更新 dump，见决策 46/47）

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
| 33 | **「放送」季要能兜底到首播日期** | 排期字段（`year`+`season`）只有 Mikan 季度页给；扫描进来的老番、系列里的**骨架行**都没有 → 「放送」整行消失（用户就是从系列里点进 2004 年的《死神》时发现）。现在 `seasonTextOf()` 先看排期字段，没有再按 `air_date` 推（`seasonOf`）—— 实测 `2004-10-05` → `2004 秋` |
| 35 | **「全是剧场版」的判据要落库（`series_all_movies`）** | `allMovies` 是 AI 现算的，但后续走链因为「根名已有」**会跳过 AI** → 判据丢了，番外被重新清零（实测哆啦A梦一半有季位、一半 NULL）。现在把判据写进系列代表行的 `series_all_movies`，走链只查库 |
| 36 | **剧场版系列重排 = 整条系列 + 一个事务 + 先补日期** | ① 只排「本次走链看到的成员」够不着别的链写进来的行 → 按 `series_id` 整条重排；② 两条链并发写会交叉 → `BEGIN IMMEDIATE` 包住；③ 新补的骨架行没有 `air_date` 只能排到最后（看着就是乱排）→ 排序**前**先给缺日期的成员各取一次 BGM `subject.date`，只写 `air_date`（不动 `year/season`）。实测哆啦A梦 33 部 = 1980-03-15 … 2026-02-27、蜡笔小新 34 部，**顺序倒退 0 处**；同类一次修好 16 个系列 |
| 37 | **库里没有的组：只显示标记，不入库** | 文件名开头的方括号是发布者自己写的，Mikan 没有「统一的组名字段」：同一个组在不同作品里写法可能不同，抄进 `subgroup` 字典只会跨作品污染（还会把番名/画质当成组）。所以判定分两层：① 字典里认得出 → 用官方组名；② 认不出 → **照原样显示标记本身**（`APTX4869` / `GJ.Y` / `黒ネズミたち`），并用 `isLikelyGroupTag` 挡掉画质/编码/语言/纯数字。实测《名侦探柯南》「全部」视图：归类 75.9% → **98.3%**（4456 条里 4381 条有标签），字典条数不变（272 → 272），标记 0 条进库 |
| 38 | **归档命名规范：`{根}/{番名}/Season 01/{番名} S01E04.mkv`** | 旧数据是 `{根}/{番名}/SE01` + 文件名**两种并存**（113/176 改过名、其余保留原始文件名）。选 `Season NN`：Jellyfin / Plex / Emby 都只认这个写法，`SE01` 一律识别不出季；文件名只在**单集**时改名（合集保原名，改了反而破坏分集信息）。`archiveDirOf()` / `buildTags()` 是唯一出处，**后续批量迁移**（`setLocation` 改目录 + `rename_file` 改文件）以后单独做脚本 —— 现在不改老数据，读取端对新旧两种写法都认（`seasonIndexOf`） |
| 39 | **下载页以 qB 为事实来源，库里只补名字** | 下载状态存库必然与 qB 打架（qB 重启/手动暂停/改名都会漂），而且要写同步任务。现在：种子列表直接读 qB（缓存 4s），`anime` 表只用来补「这是哪部番 / 海报 / 总集数」。**种子 → 作品的身份来源按可靠度三级**：① 标签 `soraika:[番剧id]…`（旧系统，126/176）② 标签 `mid:…`（现在写的）③ **种子名本身就是旧格式**（另外 50 条标签是空的，名字里带完整 `[id][番名][季][集][组rssId][组名]`）→ 实测 176/176 全部能认回作品，`unmatched` 为 0；认不出才按归档目录名兜底，再认不出才归到「未识别」 |
| 40 | **qB 的「通」= 拿到版本号，而且两个版本都要** | 只看状态码会把「服务在但 Key 错」判成成功。`/api/v2/app/version`（应用，如 `v5.2.1`）+ `/api/v2/app/webapiVersion`（WebAPI，如 `2.15.1`）都拿到才算通，并且**两个都显示**：只有应用版本时，遇到「接口字段对不上」看不出是不是 WebAPI 太低。设置页 `detail` 直接写 `v5.2.1 · WebAPI 2.15.1`，`versions` 同时给程序用（下载页顶部也显示） |
| 41 | **画质 / 字幕 / 片源：加种时写进 qB 标签** | 这三个信息只存在于**发布名**里，而我们会在下载后改名（旧系统 113/176 条改成了 `番名 S02E23.mp4`）—— 改完就永久丢了，事后推不出来。所以加种时把它们写成标签：`res:1080P` / `sub:简日内嵌` / `src:WEB-DL`（连同 `soraika` / `mid:` / `sg:`）。好处：跟着种子走（改名、换目录都不影响）、qB 里能直接按标签筛、人在 qB 界面也看得懂。读取时**标签优先、名字兜底**，历史种子照样能显示（有名字的） |
| 42 | **下载页的「已下载」= 一份扁平清单 + 字幕组筛选** | 一开始按字幕组分成几段（先选组再看列表），实测很别扭：一部番只有 1~2 个组在活动，大半的组只有 1 条，得点两下才看得到。用户要看的是「我下到第几集了」——组名是**附注**（每行右侧一行小字），不是分类维度。所以：默认「全部」铺平、按集号倒序；顶部 chip 退化成**筛选**（不是数据源），而且**只有一个组时整块不渲染**（筛了等于没筛） |
| 43 | **AI 解析速度 = 别重复问 + 批别太大** | 两个实测出来的坑：① 面板同时发 `tags` + `episodes`，算的是同一个 bundle，原来都 miss → **并发打两次模型**（日志里成对出现 5466ms + 5546ms）；② 单批 120 条要模型吐 120 条集数 + 几十个标签，**一次 18.7 秒**，而 `ai.concurrency=3` 根本没机会用上。修法：同一个 key 的在途请求**合流**（一个去问、其它搭车，返回 `cached:true`）；单批改成 **40 条**，120 条 = 3 批并发 → **7.0 秒**（实测）。两个数字都在 `verify-ai` 里钉住 |
| 44 | **提示词是数据，不是代码** | 调一句 prompt 就要改源码 + 重启，还得手动对齐版本号 —— 每次都败在"忘了升版本 → 命中旧缓存 → 以为没生效"。现在四段提示词都在 `api/ai/prompts.json`（出厂默认，进 git 可 review），**`data/prompts.json` 覆盖 + 按 mtime 热加载**（改完立即生效、不用重启），并且有 `GET/PUT /api/ai/prompts`。缓存 key 用**提示词内容 hash**：改了就自然 miss，不再依赖谁记得升版本（版本号退化成元信息）。空提示词一律 400 |
| 45 | **提示词拆两段：系统契约（我们的）+ 用户补充（你的），跑偏就回退默认** | 模型能不能用取决于提示词里有没有把 JSON 结构写清楚；用户调措辞时最容易顺手删掉结构说明，结果模型返回散文，现象是「资源区标签突然全没了」，很难联想到提示词。所以：① 每段提示词分 `system`（输出结构、字段名、禁止事项）与 `custom`（偏好、措辞）两块，发送时 system 在前、custom 在后（`composePrompt`）；② 保存时校验 `system` 必须保留关键字段名（bundle 要 `"tags"`/`"display"`/`"match"`/`"episodes"`，series 要 `namingStyle`/`rootTitle`/`extras`，format 要 `prefix`/`literals`，groupTags 要 `{{NAMES}}`），缺了就 400 并指出缺什么，`custom` 随便写（限 4000 字）；③ **模型跑偏时自动回退**：JSON 解析失败或 tags 与 episodes 同时为空 → 用出厂默认的 system 段（不带 custom）重跑该批，结果带 `promptFallback: true`，日志 `ai.bundle fallback-default`。回退只影响这一次请求，不改任何配置；④ **界面只编辑 custom**：系统段在设置页不展示（普通用户不该动契约），只显示「系统段 N 字（程序维护）」+ 指路 JSON 文件；保存只提交 custom，不会覆盖别人手改的系统段 |
| 46 | **老番档案用 BGM 离线 dump 批量刷，不走逐条 API** | 档案补齐是「一条一次请求」，3762 部老番要跑几十分钟还会被限流（镜像 20 次/秒就 429）。`github.com/bangumi/Archive` 每周三导一次全站，`subject.jsonlines` + `episode.jsonlines` 一共 1.3GB —— 本地流式扫一遍，**3742 条 4.3 秒**就落完，一条请求都不发（实测 `needArchive 222 → 191`、`withScore 3711 → 3745`）。四条约束：① **只补库里已有 `bgm_id` 的行**（dump 是全站含漫画/游戏/三次元，主表入口仍然只有 Mikan 排期）；② **不写 `year`/`season`/`weekday`**（排期归属只有 Mikan 能写），**不写 `poster_src`**（dump 里没有封面）；③ **总集数只增不减**（周更快照会比上游登记慢，直接覆盖会把「共 12 集」改成「共 8 集」，下载页的「已下载 8 / 共 12」就假了）；④ 落库顺手写 `bgm_checked_at`，档案队列不再为这些行打上游（当年番的每日更新不受影响，仍走 API 拿当天数据）。字段口径与 `bgmToRow` 完全一致（`meta_tags` 优先、标签最多 8 个、`rating_total` = 各档人数之和） |
| 47 | **离线 dump 自动更新：digest 比对 → 镜像竞速 → 断点续传 → 流式解压** | 手点每周一次不现实，但每天拉 450MB 更荒唐。做法：① `dump_state` 存上次导入的 sha256，索引（539B）digest 一样就直接结束 —— **一周 6 天只花一次 539 字节请求**；② 索引与下载都多源（raw / jsDelivr / gh-proxy），`sources.pickFastest` 决定"竞速选最快"还是"按列表"；③ 下载写 `.part` + `Range` 续传（跨镜像也能续），边下边算 sha256，**不符就删**；④ **不解压到磁盘**：直接从 zip 中央目录取两个条目，`zlib.createInflateRaw` 流式喂给解析（磁盘峰值 450MB vs 1.75GB）；⑤ 失败只记日志 + 10min/1h/6h 退避，旧数据照用。实测：缓存 zip 导入 3742 条 **5.1 秒**，整趟 6.4 秒；`--check` 二次调用直接 up-to-date |
| 48 | **筛选标签可以「默认勾上」，且由提示词决定** | 每次都要手点「1080P + 简日内嵌」很啰嗦。做法：标签对象多一个**可选**字段 `default`（模型只在【用户补充要求】明确说「把 X 设为默认勾选」时才给 true，最多 2 条；`all: true` 的不许给）；服务端透传并强制把 `all` 的清零；`useAiTags` 在新结果落地时按 `tag.default` 自动勾上（上限 4 条）。不在 `PROMPT_CONTRACT` 里要求这个字段 —— 它是可选的，强制要求会拒掉别人手写的 system |
| 49 | **换作品：骨架屏至少 260ms + 详情轻微淡入** | 本地详情 20~50ms 就回来，骨架只渲染一帧 → 观感是「闪一下内容就变了」（用户原话「切换海报的强制动画有点生硬」）。做法：`MIN_LOADING_MS` 180 → **260ms**（比一帧长、又远短于一次 AI 解析 2s+，正好盖住等待），详情挂载时 `detail-in` 淡入 + 上浮 8px（`:key=detail-id` 保证换作品才重放），并尊重 `prefers-reduced-motion`。仍然**不做整块淡出淡入**（那是旧版被吐槽的"整页在进"） |
| 50 | **身份映射单独一张表（`mikan_bgm_map`）—— 重建排期不丢映射** | `anime` 是"排期 + 展示"的产物，随时能重建（重扫 Mikan）；但「哪个 mikan_id 对应哪个 bgm_id」丢了就得重扫几千个页面。所以把身份搬进独立表：① 排期落库时顺手 `rememberMikan`（只记 mikan_id + 标题）；② 补齐队列**在映射表上跑**（`bgm_id IS NULL AND checked_at 过 30 天`），成功写 `bgm_id`、失败只记 `checked_at` —— **不再记"失败了几次"**（有没有链接是事实，不是次数）；③ 扫描（`npm run sweep`）只写映射表，不再往 `anime` 塞行。迁移时按 `mikan_id` 从老库回填（实测 3257 条 = distinct mikan_id，其中 3241 有 bgm、16 条冷却中）。下一步再把档案列拆进 `bgm_subject`（见 `docs/SCHEMA-V2.md`） |
| 52 | **档案单独一张表（`bgm_subject`）—— 可整表重灌，先做"影子期"** | 评分/标签/简介/放送日/集数/平台每周都被 dump 整份覆盖，而 `anime` 是排期+展示。v2.5 先建表 + 启动回填（实测 3747 条，与 `withBgm` 一致）+ **双写**（dump 导入 & API 补齐都写它，`source` 区分），读取仍走 `anime` —— 这一步零风险；下一步把读取改成 JOIN 并删掉 anime 上的档案列（那时档案表才真正"可整表删掉重灌"）。口径与 `bgmToRow` 一致（meta_tags 优先、标签 ≤8、`total_episodes` 只增不减） |
| 51 | **集数改成「按序数组」输出，布尔只在 true 时写 —— 直接砍输出 token** | AI 的耗时几乎全在**输出**上，而旧格式 `episodes: { "完整文件名": 12 }` 把每个文件名又抄了一遍（10 条就接近 700 个输出 token）。改成：① `episodes: [12, null, "1-12", ...]`，**顺序即 index**（输入本来就是编号列表）；② `all` / `default` 只在 true 时写，false 不写。实测同一批 10 条：**completion 706 → 337 token（-52%）、耗时 2.95s → 1.83s（-38%）**。解析层 `episodesFrom` 同时兼容旧的「对象」写法（模型不听话时也不崩），数组比标题长时只认前面的。顺带修掉一个真 bug：**只保存 custom 时会把当时生效的 system 抄进 `data/prompts.json`**，导致出厂提示词升级永远盖不过旧副本（v12 改了等于没改，实测模型仍在返回对象）—— 现在覆盖文件只写「本次显式给的 system」 |

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
| 剧场版系列一半有季位、一半是番外 | `allMovies` 靠 AI 现算，走链「根名已有」就跳过 AI → 判据丢失 | 判据落库 `series_all_movies`（决策 35） |
| 剧场版按日期排，实际是「1980→1990→…→2004→2017→ 1981、1982…」 | 排序键 `air_date` 有空值，空值只能排最后 | 排序**前**先补日期，补不到的才轮到末尾（决策 36） |

---

## 9. 验证体系（改动必须能验收）

| 脚本 | 钉什么 |
|---|---|
| `Server/scripts/verify-home.mjs` | 首页契约：字段/文案/缓存/出图/海报三级链/预热/优雅停机 |
| `verify-detail.mjs` | 详情 + 系列（含名字判定）+ 字幕组 + 资源 + 表结构不变式 |
| `verify-ai.mjs` | 工具清单、入参校验、未配置降级、**全量分批**、缓存命中 |
| `verify-settings.mjs` | 字段清单、校验、密钥打码、导出导入、连通测试、重置 |
| `verify-archive.mjs` | 离线 dump 的字段映射（meta_tags 优先级 / 人数求和 / 只数正篇 / 空值不覆盖）、只补已有 bgm_id、`--only-missing`、`bgm_checked_at`、**从 zip 直接导入**、**自动更新（索引多源 / digest 跳过 / Range 续传 / sha256 / 镜像切换）** |
| `verify-worker.mjs` | 队列谓词与计数一致、认领 CAS、系列队列不丢任务 |
| `Web/scripts/verify-e2e.mjs` | 真数据渲染 + 面板三态 + 骨架屏 + 排序/分页 + 各组件结构断言 |

约定（CONVENTIONS §8 / Web §14）：**每处改动都在对应 verify 里加断言**；
临时脚本 `tmp-*.mjs` 用完即删（两边 `.gitignore` 已忽略）。

---

## 10. 路线图

**P0 · 数据完整性**
- [x] Mikan↔BGM 映射全量（3233 / 3237）
- [x] 档案补齐（评分/标签/简介）—— `needArchive 2769 → 860`（后台在跑）
- [x] **用 BGM 离线 dump 一次刷完**（决策 46）：`needArchive 222 → 191`、
      `withScore 3711 → 3745`，3742 条在 **4.3 秒**内落库，一条上游请求都没发；
      剩下的 191 条上游**确实没写简介**（不是漏抓）
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





