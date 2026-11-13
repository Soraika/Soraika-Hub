# Soraika's Hub —— 服务端约定

> 目的：把「代码放哪、怎么写、怎么验」定死，不再靠临场判断。
> 最高原则：**先把语义写清楚，再写实现** —— 队列状态机、数据源分层、权威层级都属于语义，不是实现细节。
> 适用范围：`Server/`。新代码照此执行；存量代码按重构步骤逐步对齐（文末有自检清单）。
>
> **先读哪份**：整体架构 / 数据流 / 关键决策 / 路线图 → **`docs/ARCHITECTURE.md`**；
> 还没做的事 → `docs/TODO.md`；对外 AI 协议 → `docs/MCP.md`。
> 本文只管「写代码时的约定」，不重复架构说明。

---

## 0. 术语表

| 术语 | 含义 | 容易混淆的点 |
|---|---|---|
| 作品 | 库里的一部番（`anime` 表一行），`id` 是**作品主键** | 前端 `orderKeyOf` 只认它 |
| 来源 id | `mikan_id` / `bgm_id` | 只说明「数据从哪来」，**不是作品身份** |
| 档案 | 一部作品的全部字段：标题 / 海报 / 评分 / 评分人数 / 标签 / 简介 / 集数 / 放送日 + 字幕组列表 | 「补齐」补的是**档案**，不只是评分 |
| 补齐（触发①） | 把 `bgm_id IS NULL` 的作品档案补上 | 不限季 |
| 每日更新（触发②） | 按「久远程度」刷新档案：间隔 = (当年 - year) + 1 天（今年 1 天、越老越慢） | 不是「只刷今年」；`year` 为空按 3 天（见 §10.4） |
| 权威映射 | `mikanId → bgmId`，唯一可靠来源是 **Mikan 详情页里的 Bangumi 链接** | 不用标题猜测 |
| 成品字符串 | 后端拼好的展示文案（`ratingText` / `scoreText` / `metaText`） | 前端不做格式化（连 `toFixed` 都不写） |
| 排期主源 / 评分源 | Mikan（星期 / 番名 / 封面 / mikanId）/ Bangumi（评分 / 人数 / 标签 / 简介） | 两者不要互换 |
| AI 能力 | 资源文件名 → 筛选标签（可点）+ 集数（**同一次调用返回两组产物**）/ 系列的命名归一（§10.1） | 「没配 key」是**未配置**，不是失败 |
| 提示词版本 | 改了 prompt 必须同步升版本；缓存 key 还要带 **prompt 内容 hash + model** | 不升版本会命中旧结果，看起来「提示词没生效」 |
| 界面与交互约定 | 见 **`Web/CONVENTIONS.md`**（配色/尺寸/静默/参照旧版…都以那份为准） | 前后端约定分开维护，各管一摊 |
| 工具清单 | `AI_TOOLS`：对外暴露的能力定义（MCP `tools/list` 形状） | 必须与 `callAiTool` 的实现一一对应（含 inputSchema 里声明的参数） |
| 系列 | 同一部作品的播出线（进击的巨人 S01..S04） | BGM 没有「系列」字段，是我们按关系走链算出来的（§10.1） |
| 代表行 | 系列的锚：链上 `air_date` 最早且已在库的那条，`series_id` 取它的 `anime.id` | 根名 / 命名风格只写在它上面（§10.2） |
| 映射 | `mikanId ↔ bgmId` | 反方向（bgmId → mikanId）只能靠预扫的表（§10.3） |

---

## 1. 分层与依赖方向

依赖只能向下：`routes → api → (db | sources) → domain → lib`；`jobs` 与 `api` 平行，都建立在 `db` + `domain` + `lib` 之上。

| 目录 | 做什么 | 禁止 |
|---|---|---|
| `routes/` | 校验入参、调 api、拼 `{ ok, data }` / 错误信封 | 写业务、直接查库、直接抓上游 |
| `api/pages/` | 页面级编排：取数顺序、库优先、组装响应 | 拼 SQL、解析 HTML |
| `api/mappers/` | 行 ↔ DTO 映射、分组、排序（`toCardItem` / `groupByDay` / `toAnimeDetail`） | 取数、写库 |
| `api/sources/` | 封装单个外部源（mikan / bgm / ai / qb），输出归一化字段 | 落库、拼展示文案、业务判断 |
| `db/` | 表 CRUD（`anime.js`）与**队列语义**（`queue.js`）分开 | 发 HTTP、拼文案 |
| `api/sources/transport/` | 纯抓取 + 解析（请求、重试、cheerio），只认 URL 与字节 | 落库、业务判断、认识 config 之外的东西 |
| `domain/` | **业务规则**（纯函数）：种子叫法 `qb-naming`、归档命名 `downloads`、标签与匹配 `release-*`、系列链 `series` | 发请求、碰库、依赖 `api/` |
| `lib/` | 基础设施：`config` `logger`(pino 单例) `errors` `http-client` `multi-source` `format` `settings` `unzip` | 反向依赖上层目录、写业务规则 |
| `jobs/` | 后台任务：队列循环、节流、状态快照 | 被 `routes/` 直接调（要走 api 层） |
| `cache/` | 进程内 TTL / 单飞 | 存持久化数据（那是 `db/`） |

---

## 2. 命名

- **文件**：小写、语义化；不要用 `v2` / `new` / `backfill-bgm` 这类历史命名（叫 `enrich.js`）
- **函数前缀**：`fetch*`（外部源）、`list* / find* / count*`（读库）、`upsert* / apply* / mark* / replace*`（写库）、`run*`（任务）、`get*`（聚合 / 快照）
- **变量**：JS 用 camelCase（`mikanId`、`bgmId`）；数据库列 snake_case；env 全大写
- **日志消息**：`模块.动作 结果`，例如 `worker.enrich ok`、`api.req fail`

## 3. 注释规范

只写四类内容：为什么这样做、约束 / 前提、坑与边界、术语。
禁止：试错过程（「踩过」「我第一版写成…」）、口语、复述代码表面行为。

写法（2026-11 起统一，别再用 markdown 语法）：

- 正文写中文纯文本。不要用 `**加粗**`、不要 `#` 标题、不要表格、不要 `-` 列表符号
  （用「·」或换行分行）。编辑器不会渲染 markdown，`**` 只会原样露在眼前。
- 代码标识符直接写，不用反引号包：`messageOf` 写成 messageOf。
  只有会被工具解析的地方才用 JSDoc 标签：导出函数的 `@param` / `@returns` / `@typedef`，
  以及给编辑器做类型提示的 `/** @type {...} */`（VS Code 的 TS 服务会读它，hover 能看见）。
- 不引入 Doxygen：它对 Vue SFC 没有支持，对 JS 也只是把 JSDoc 再解析一遍；
  我们要的「hover 看说明、参数提示、跳转」VS Code 原生就吃 JSDoc，不需要额外工具链。
- 分节标题保留 `/* ── xxx ─── */` 那种横线（它是视觉分隔，不是 markdown）。

文件头模板：

```js
/**
 * 一句话说明这个模块负责什么
 * ---------------------------------------------------------------------------
 * 为什么需要它 / 关键约束（1~3 条，结论前置）
 * 协作关系：上游是谁、下游是谁
 * 边界：明确不做什么（免得以后被塞进不属于它的职责）
 */
```

分节标题：

```js
/* ── 作品档案 ─────────────────────────────────────────────────────────── */
```

---

## 4. 日志规范

**不重复造轮子**：日志用成熟的 `pino`（logger）+ `pino-http`（请求日志中间件）—— 请求 id、耗时、状态码序列化它们都做好了，别自己写中间件。

**消息文案必须严谨**（这条被用户点过名）：

- 格式固定 `模块.动作 结果`，全小写英文 —— `worker.enrich ok`、`img.fetch fail`、`mikan.profile retry`
- **消息里不写中文句子、不写箭头、不写"多半/大概/也没给"这类口语**；
  解释与原因放**字段**或**代码注释**里，例如
  `log.warn({ id, mikanId, fallback: 'all' }, 'anime.subgroups detail-404')`
- **错误文案（会回给前端的 `error.message`）同样要严谨**：一句话说清"哪里、什么、怎么办"，
  不写推测口吻 —— ✅ `页面内容校验失败：未解析到预期节点（AnimeDetailPage）`，
  ❌ `页面内容校验未通过（多半是上游返回了空壳页）`

- **基础 logger**：`lib/logger.js` 里的 pino 单例；`LOG_LEVEL` 控级别，开发用 `pino-pretty` 单行彩色，`NODE_ENV=production` 输出 JSON 供采集
- **请求日志**：`pino-http` 挂在 `index.js` 装配处，自动注入 `req.log`（带 requestId），业务代码不手动打印请求信息
- **服务层接收可选 logger**：签名写 `{ log = logger }`；请求路径传 `req.log`（同一次请求的日志靠 requestId 串起来），后台任务用默认 logger
- **禁止 `console.*`**（CLI 给人看的汇总也走 logger）
- 消息格式：短句 + **结构化字段**，字段用对象传，不要把一切拼进字符串

| 级别 | 用途 |
|---|---|
| `debug` | 单条上游请求 / 解析细节（默认关闭） |
| `info` | 业务节点：启动 / 停止、队列推进、每日更新开始与结束、DB 迁移 |
| `warn` | 可恢复异常：单条上游失败、拿不到 bgmId 并退避、HTTP 4xx |
| `error` | 需要人介入：配置非法、DB 打不开、连续失败 |

好 / 坏对照：

```js
// ✓ 好：字段可检索、文案短、模块前缀统一
log.info({ id, mikanId, bgmId, subgroups, score, ms }, 'worker.enrich ok')
log.warn({ id, mikanId, misses, limit }, 'worker.enrich no-bgm-link')

// ✗ 坏：全部塞进一句话、没有字段、还带 emoji
log.info?.(`✓ ${row.title}｜bgmId=${x}｜字幕组 ${n} 个｜评分 ${s}（${t} 人）`)
```

---

## 5. 队列与后台任务规范

新增任何队列，**先把下面 7 条写清楚，再动代码**：

1. **谓词**：什么算「待处理」（如 `bgm_id IS NULL`）—— 必须同时给出**退出条件**，否则必然死循环
2. **认领**：并发安全（CAS：`UPDATE ... WHERE id = ? AND <读到的标记> IS ?`，`changes === 1` 才算抢到）
3. **处理**：一条一个事务边界；**幂等**（重复执行结果一致）
4. **退出**：什么情况下**离开**队列（成功写入 / 判定放弃）
5. **退避**：失败怎么办（计数 + 上限 + 冷却期），且要区分「网络抖动」与「上游确实没有」
6. **恢复**：进程重启后如何续跑（分界线 / 标记落库，不依赖内存状态）
7. **可观测**：队列长度 + 已处理数进 `/api/health`，且能区分「队列空」与「永远补不了」

现成模板：`db/queue.js` + `jobs/worker.js`（**三个触发**：补齐 / 每日更新 / 系列链补齐，
**每轮各推进一条** —— 否则长队列会把短队列饿死）。

触发③（系列链补齐）是「新作品入库才算一次」的队列，七条落在 `db/queue.js` 的注释里，要点：

- 谓词 `bgm_id IS NOT NULL AND series_checked_at IS NULL`（谁没算过算谁）
- 认领把 `series_checked_at` 置 **-1（哨兵 = 处理中）** 再 CAS 判定 —— 不新增列就拿到「正在处理」语义
- 成功写真实时间；失败 / 未配 AI → worker 放回 `NULL`（下轮再来）
- 退避在 worker 内存里做（连续失败 5s→10s→…最多 10 分钟），别在上游抖动时反复打
- 启动时 `resetStaleSeriesClaims()` 把上次崩在中间的 `-1` 清回 `NULL`

---

## 6. 配置规范

**两层来源，优先级从低到高**：**代码默认值（`config.js`）→ 设置页（存 `settings` 表）**。
**不读 `.env`** —— 只有三个启动参数走环境变量（进程起来之前就得知道、界面上改不了）：
`PORT` / `DB_FILE` / `LOG_LEVEL`。

只有**设置页改过的项**才进库（不是全量快照）—— 这样以后新增配置项，老库不会因为「缺这个键」而出错。

- **字段清单是唯一来源**：`lib/settings.js` 的 `SETTINGS_FIELDS` 决定「能改什么、怎么校验、设置页长什么样」；
  加一个配置项 = 改这一处 + `config.js` 的默认值，**前端不用动**（表单由后端清单驱动）
- **启动时先回落代码默认值、再套用库里的覆盖项**（`api/pages/settings.js` 的 `loadStoredSettings()`）：
  API 进程与独立 worker 进程都要在开工前调一次，否则两边读到的配置会不一致
- **校验一律走 `validateValue`**：非法值整批拒绝（400 + `detail.errors` 指出哪一项），不做「改一半」
- **`restart=true` 的项**（端口、落盘目录、缓存实例 TTL、`worker.inline`）是启动时读进局部变量的，
  改了要重启对应进程 —— 清单里必须标出来，设置页会显式提示
- **启动参数不可编辑**：`PORT` / `DB_FILE` 只做只读展示（改错会连不上自己 / 连错库，得在终端解决）
- **密钥规则不变**：只走 env 或设置页；**接口永不回明文**（只回「配没配 + 打码预览 `sk-…7890`」）；
  导出**默认脱敏**，`?secrets=1` 才带（文件名标 `with-secrets`，防误发）
- 导入：值不合法整包拒绝；未知项忽略并回报（跨版本迁移不卡住）

---

## 7. 错误规范

- 只用 `lib/errors.js` 的错误码：`BAD_REQUEST / NOT_FOUND / INTERNAL / UPSTREAM / PARSE / NETWORK / AI_DISABLED`
- **`AI_DISABLED`(501) 专指「功能没配好」**（例如没填 AI key）：这是已知状态，不是故障 ——
  用它区分「失败请重试」与「去配置」，别把它归到 INTERNAL（那会让人以为程序有 bug）
- 响应统一 `{ ok: false, error: { code, message, detail? } }`
- **`detail` 分级**：只放排错需要的上下文；禁止把上游响应原文、密钥、内部路径透给前端
- 语义要落到正确的码：解析不出条目 = `PARSE`（多为页面改版）；非 2xx = `UPSTREAM`；连不上/超时 = `NETWORK`
- 前端只认 `code`（决定文案与是否给重试按钮）

---

## 8. 调试产物与验证

- 一次性脚本放 `Server/scripts/`（前端对应 `Web/scripts/`），命名 `tmp-*.mjs`，**用完即删**；两边 `.gitignore` 都已忽略 `scripts/tmp-*`
- 长期保留的验证脚本命名 `verify-*.mjs`：后端 `npm run verify` / `verify:worker`，前端 `npm run verify:e2e`，**失败必须非 0 退出**
- 每个改动都要附**可复现证据**（命令 + 实测输出），不接受「应该没问题」
- **禁止在仓库根目录留临时文件**（曾经误生成过一个名为 `'` 的文件）

---

## 9. AI 能力与对外协议（MCP 预留）

AI 是**可选功能**：没配 `AI_API_KEY` 也照常跑 —— 相关接口回 `AI_DISABLED`(501)，
前端显示「未配置」而不是「失败重试」。别把「没配」混进「失败」。

- **分层**：`api/sources/ai.js`（供应商调用 + 抠 JSON，认 config）→ `api/pages/ai.js`（业务能力 + prompt + 缓存）
  → `api/ai-tools.js`（对外清单 + 分发）→ `routes/ai.js`（HTTP）
- **一个能力只写一遍**：`AI_TOOLS`（清单）与 `callAiTool`（实现）是唯一入口，HTTP 的 `/api/ai/call`
  与将来的 MCP 都从这走；加能力 = 清单加一条 + switch 接上，别在路由里另写一套
- **缓存按内容哈希**（不是条数 —— 旧版按数量做 key，不同内容同长度会互相串），
  **key 里必须带 prompt 内容 hash + model**（换 prompt / 换模型都不会命中旧结果）：
  标签 30 分钟 / 集数 24 小时；**标签与集数合并成一次调用**（一次返回 `{ tags, episodes }`，省一半请求），
  批次按输出体量定（120 条时输出很长、必要时降到 60），输出被截断的表现是 `PARSE`
- **prompt 与结果解析留在能力层**；`extractJson` 抠不出 JSON 归 `PARSE`（重试没用，要改 prompt）
- **自然语言搜索只翻译意图**：`POST /api/anime/ai-search`（也是 MCP 工具 `anime_search`）让模型输出
  `{ keyword, year, season, weekday, minScore, tags, picks, reason }`，结果仍由确定性搜索给出。
  三条硬规则：① `picks` **只能从服务端给的候选池里挑**（`db/anime.js#searchCandidates`），编造的 id 一律丢；
  ② 关键词取自候选标题（`exactTitle`）时忽略模型给的筛选条件（实测它会顺手塞一个没人要的 `weekday=0`）；
  ③ 没配 AI → 501，前端退回关键词搜索，不把「未配置」当失败。
- **对外协议**：`GET /api/ai/tools`（MCP `tools/list` 形状）、`POST /api/ai/call`（`tools/call` 形状），
  包 MCP server 的完整做法见 `docs/MCP.md`
- **key 不外泄**：`/api/health` 与 `/api/ai/tools` 只给 `enabled` / `model`，没启用时连 baseUrl 都不给
- **prompt 从参数进来**：`chatJson({ system, user, provider })` —— 调用点只说「这次用哪份 prompt / 哪个供应商」；
  以后「多提供商 + 用户自定义提示词」只改「谁来提供这两个值」，调用点一行不用动
- **覆盖文件只写「用户改的那一段」**：`data/prompts.json` 里出现 `system` 就等于把出厂提示词**钉死在那一版**，
  以后升级出厂提示词会被它盖住（实测踩过：v12 改了集数输出格式，模型照旧返回旧结构）。
  所以 `PUT /api/ai/prompts` 只在请求**显式给了 system** 时才写它；只传 custom 时 system 回落到当前出厂默认。
- **输出能省就省**：模型耗时几乎全在输出 token 上。`episodes` 用**按序数组**（顺序即 index，不重复文件名）、
  `all` / `default` 只在 true 时写 —— 同一批 10 条实测输出 706 → 337 token、2.95s → 1.83s。
- **`provider` 是一份快照对象**：`{ baseUrl, apiKey, model, timeoutMs, maxTokens, params }`；
  不传 = 用 `config.ai`（现行为）。**不要传 `config` 本身**（避免调用中途设置被改）
- **供应商差异不写死**：`thinking: { type: 'disabled' }` 是 DeepSeek 专有的，别的网关会忽略 → 放 `provider.params`

---

## 10. 系列链、Mikan↔BGM 映射与归档目录

> 「下载归档」的前置：把「同一系列的第几季」「某个 bgmId 在 Mikan 是哪一部」落成可查的数据。
> 三条共同前提：**能确定的绝不问 AI**、**不依赖需要梯子的站点**、**只读库就能回答**。

**10.1 系列链（走链 + AI 归一）**

- **只用镜像 API**：`GET {config.bgm.bases[i]}/v0/subjects/{id}/subjects`（1 跳；`bases` 是**有序候选**，见 §7 多源）。
  `bgm.tv/subject/{id}/relations/graph` 里虽然有现成的 `SUBJECT_SERIES_GRAPH`（一次给全、带 year/auxiliary），
  但**它要梯子**，不作依赖；只在有梯子时拿来交叉校验链序。
- **关系优先读离线 dump**：`subject-relations.jsonlines` 是全站关系表（zip 里 6.1MB 压缩 / 72MB 解压），
  导入时只留「和库里的 bgm_id 有关 + 类型在 `{2,3,4,5,6,12}`」的行写进 `bgm_relation`，
  链上条目的名字/类型/日期写进 `bgm_stub`（建骨架行、排剧场版季位都用得上）。
  `loadRelated` 因此变成两次索引查询（`bgm_relation` + `bgm_stub`），**一条链 0 次上游请求**；
  数字含义是拿 API 逐条对照出来的：`2 前传 / 3 续集 / 4 总集篇 / 5 全集 / 6 番外篇 / 12 主线故事`
  （dump 通常两个方向都写，只有单边时用逆关系补）。设置页关掉「离线数据」或关系表为空时，
  仍然退回上面的镜像 API —— 两条路给 `walkSeries` 的是同一个回调契约。
- **逐条回退（在线只补「dump 没覆盖的那一条」）**：读本地没有行、且 `bgm_stub.relations_checked_at`
  为空（= 从没问过）时，才为这个 id 打一次 API，并把结果写回关系表 + 标记「问过」；
  下次走链直接命中本地。标记很关键：「确实没有关系」和「还没问过」必须能分开，
  否则没有续集的作品会每周白打一次上游。
- **BFS 展开规则**：只沿 `relation ∈ {续集, 前传}` 且 `type === 2`（动画）的边扩展；
  **番外只收白名单**（`EXTRA_RELATIONS = 番外篇 / 总集篇 / 剧场版`），白名单外的关系**连收都不收**。
  为什么必须白名单：实测《异世界四重奏》↔《OVERLORD》互为 **「角色出演」**（交叉作品，各自还有自己的
  正传链），一旦当番外收进来，两次走链会互相把对方写进自己的 `series_id` → 两边混成一个系列、
  `series_index` 还会撞（出现两个 `index=1`）。「衍生 / 联动 / 相同世界观 / 系列 / 原作 / 片头曲 /
  游戏 / 书籍…」同理，全部丢弃 —— 否则会顺着「联动」跑到《王者荣耀》《堡垒之夜》去。
- **`series_id` 首写优先**：一行已经归属别的系列时，后算的不抢（只记 `conflicts` 日志），
  避免两个系列把同一行覆盖成混合状态。
- **一遍遍历拿三样**：请求数 = 链长（进击的巨人 8 次、物语 12 次），正传链 / 番外清单 / 链序在同一次遍历里得到。
  番外**不能只看某一部**：实测 S1 的 1 跳只有 11 条番外，扫整条链才是 16 条。
- **`series_index` 由链位给**（链头 = 1）：不看名字、不看年份、不看 id、不看列表顺序。
  理由：BGM 上第一季的名字里没有「第一季 / S1」（就叫《进击的巨人》），靠名字必然漏掉它；1 跳返回的顺序也不保证升序。
- **`relation` 存「归一后的绝对类别」**：BGM 的原始 relation 是「相对当前条目」的
  （实测 `LOST GIRLS` 在 S1 是「番外篇」、在 S2/S3 是「衍生」）→ 直接存会随入口变。
  归一取值：`续集 / OVA / 剧场版 / 总集篇 / 衍生 / 其他`（正传成员固定 `续集`，链头为空）。
- **正传 / 番外由代码判定，不给 AI**：链上的是正传、链外的 `type===2` 是番外。
  AI 只做三件事：判 `namingStyle`、给 `rootTitle`、给番外归类；`index` 是输入、不许它改。
- **AI 失败 / 未配置 → 什么都不写**（`series_checked_at` 也为空）→ 自动留在「待算」里下次重试。
- **`rootTitle` 空值兜底**：单部作品（链上只有它自己）AI 常不给总名 → 回落用代表行自己的展示名
  （`title_cn || title`），顶层目录不至于叫「未归类」。键名同时兼容 `rootTitle` / `root_title` / `rootName`
  （换个模型就容易写成后面两种）。
- **触发时机**：**新作品入库（后台补齐）时算一次** —— 也就是 worker 的触发③（`claimNextSeriesPending`，
  每轮一条 + 指数退避），链上老成员顺带归入同一个 `series_id`；老系列**不主动重算**（只有新季出现才会变）。
  手工跑：`npm run series`（补到没有为止）/ `--limit=N` / `--conc=N`（并发，只影响速度）/ `--force`（全部重算）；
  `npm run series -- --status` 只报进度、不干活。

**10.2 存储（挂 `anime` 表，不建新表）**

| 列 | 含义 |
|---|---|
| `series_id` | 系列标识：值 = **代表行的 `anime.id`**（我们自己的主键，同一系列同一个值） |
| `series_index` | 链位（1,2,3… = 第几季）；番外为 `NULL` |
| `series_relation` | AI 归一后的绝对类别（见上） |
| `naming_style` | `season`（同名续季 → `S01`）/ `volume`（异名平行作 → `01 化物语`）；**只写代表行** |
| `series_root_title` | 系列总名（顶层目录名）；**只写代表行** |
| `series_checked_at` | 算过系列信息的时间；`NULL` = 待算（既是标记也是排查依据） |

- **代表行** = 链上 `air_date` 最早、且**已在库**的那条；根名 / 命名风格只写在它上面（改一处即可）。
- 链上**不在库**的成员**不落库**（前端「缺了就是无」）→ 系列区块可能不全（只有 S02/S04 这种），这是接受的代价。
- 实测依据：36 个链节点里「续集 > 1 或 前传 > 1」的**0 个** → 链是直线，不需要 `parent` 列。

**10.3 Mikan ↔ BGM 映射（必须预建，**独立成表**）**

**为什么**：BGM 是**单向**的 —— 只能从 Mikan 详情页解析出 `bgmId`，没有反方向接口；
而系列成员与下载队列需要的正是 `bgmId → mikanId`。项目明确拒绝「按标题猜」（见 `api/sources/bgm.js` 的说明）。

**存在哪**：`mikan_bgm_map`（`mikan_id` 主键 / `bgm_id` / `title_mikan` / `checked_at`）。
为什么不塞进 `anime`：anime 是"排期 + 展示"，随时可重建；映射丢了要重扫几千个页面。
拆开之后 `rm data/hub.db` 也只丢排期，映射还在（单独备份这一张表即可）。

- **写入方**：① 排期落库时 `rememberMikan`（只登记 mikan_id + 标题）；② 扫描脚本（`npm run sweep`）；
  ③ 补齐队列确认成功后 `markMapChecked(mikanId, bgmId)`。
- **扫描**：遍历 `https://mikanime.tv/Home/Bangumi/{mikanId}`，用与生产同一套选择器：
  `p.bangumi-info a[href*=subject]` → `bgmId`；`p.bangumi-title` → 标题。
  `http-404` / 连标题都没有 → **不写**；没挂链接 → 写 mikan_id 并记 `checked_at`（30 天后自动再试）。
- **不再记"失败了几次"**：有没有链接是事实，不是失败次数。退避只看 `checked_at`。
- **anime 只补已有排期的行**：扫描不再建 `anime` 行（能进首页的只有 Mikan 排期页上的番）。
- **连标题都取不到**（页面在、但没有 `p.bangumi-title`，多半是跳回首页/空页）**也不写** ——
  否则映射表里会出现一堆既没名字也没链接的垃圾键。
- `no-bgm-link`（页面在、有标题、没挂 Bangumi 链接）**要写**：`bgm_id = NULL` + `title_mikan`，
  并记 `checked_at`（30 天后自动再试一次）。
- `ok` 的写 `mikan_id` + `bgm_id` + `title_mikan`。
- **`year` / `season` / `weekday` 不归映射表管**：排期归属只有 Mikan 季度页能写（§10.3）。
- **`anime.title` 来自 Mikan、`anime.title_cn` 来自 Bangumi**（`bgmToRow`），两者不是一回事；
  展示优先 `title_cn`（`toAnimeDetail`）。
- 实测规模（一次全量）：`mikanId` 有效区间 **183 ~ 4124**、`ok` **3235**、`no-bgm-link` 2132、`http-404` 33；
  与库里已有的 467 条映射**交叉校验 100% 一致**（0 不一致）；`bgmId` 实测**一对一**（0 重复）。
- 扫描脚本**只跑增量**（映射表里已有的 mikan_id 就是"已扫过"）+ 并发压到 3~4；别每次全量。

**10.4 刷新调度（越老越慢）**

```
age      = 当年 - anime.year
间隔(天) = age + 1            ← 今年 1 天、去年 2 天、…、10 年前 11 天
year 为空 → 按 age = 2（3 天）：它们刚灌进来、还没档案，该快点补一次
```

- 判据一条 SQL 够用（`bgm_checked_at + 间隔 * 86400000 <= now`），**不需要新列**；
  取一条刷一条（`ORDER BY bgm_checked_at ASC LIMIT 1`）—— 本地几千行扫一遍是毫秒级，不用预先算到期清单。
- **从没刷过的（`bgm_checked_at IS NULL`）绝对优先**。
- **不设每日配额**（该公式自带限流：每天到期量 ≈ Σ(组数量 ÷ 周期)）。
- `打开某季` → **只刷该季的排期列表**（1 请求）+ 把该季没档案的前 N 条推进补齐队列；
  **不要**「打开某季就并行刷该季全部详情」（一季 ~300 部 = 600 请求）。
- `搜索 / 打开某部` → **即时单条更新**（复用 `enrichOne()`）：**不走队列**（不干扰后台节奏）+ 5 分钟防抖。
- **「用户看到啥、库里没有就现取一遍」是默认姿态**（不许出现"没有就不显示"）：

  | 面板里的东西 | 现取规则 |
  |---|---|
  | 详情字段（评分 / 标签 / 简介） | 为空 → 现场 `enrichOne()` 补一次再返回（5 分钟防抖） |
  | 海报 | 本地有 → 出图入口；有图源没缓存 → **图源直链** + 后台预热存本地；没图源 → 出图入口现场问 Bangumi；回源失败 → **302 交浏览器**（见 `cache/poster.js`） |
  | 字幕组 | **每次直连 Mikan**（不吃库、不缓存），抓到顺手落库；抓不到才退化到库里已有的 |
  | 资源列表 | **每次直连上游**，不缓存（种子上新频繁，缓存会让用户看到旧列表） |
  | 系列 | 没算过就现场走一遍链（`fillSeriesFor`），顺带把同链其它已在库的成员一起标好 |

- **上游可靠性**："偶发失败"多半不是网络 —— 这类站点**不带 UA 会被当爬虫**（回 200 + 空壳页）。
  所以：请求统一带 UA / Accept-Language；重试用**指数退避 + 抖动**（别用固定长等待）；
  **解析级也要重试**（200 但连标题都解析不出来 = 这次没取到，不是"这部没有"）；
  同一个目标并发去重（面板连点只花一次上游请求）。

**10.5 归档目录规则**

```
{根名}/                        ← series_root_title（写在代表行）
  S01/  S02/  S03/  S04/       ← 正传，naming_style = 'season'
  01 化物语/  02 伪物语/         ← 正传，naming_style = 'volume'（序号 + 名字）
  剧场版/01 前篇～红莲的弓矢～    ← 番外：类别目录（series_relation）+ 序号 + 名字
  OVA/01 无悔的选择 OAD
  总集篇/01 编年史
  衍生/01 Q版剧场 飞起来！训练兵团
```

- 番外 = `series_index IS NULL`；类别目录名直接用 `series_relation` 的归一值。
- 番外序号 = 同 `series_id` + 同类别内按 `air_date` 升序（**归档时现算，不落库**）。
- **同一季的多个 Part 续编集号、不分层**：`S03` 里 Part.1（12 话）是 `E01..E12`，
  Part.2 的偏移 = 前面各 Part 集数之和 → `E13..E22`；偏移取 `anime.total_episodes` 累加。

**10.6 离线 dump 的边界（`npm run archive`）**

从 `github.com/bangumi/Archive` 下载的 jsonlines 只能做「档案刷新」，不能当第二套入库通道：

- **只更新已有 `bgm_id` 的行**。dump 里有 60 万条（漫画 / 游戏 / 三次元 / 音乐都在），
  主表的入口仍然只有 Mikan 排期与扫描（铁律），别在这里 INSERT。
- **能写的只有 `src/db/anime.js#applyArchiveBatch` 那九列**：`title_cn` / `score` /
  `rating_total` / `tags` / `watching` / `summary` / `air_date` / `total_episodes` / `bgm_checked_at`。
  `year` / `season` / `weekday` 是 Mikan 的（§10.3），`poster_*` 是出图接口的（dump 里没封面）。
- **`total_episodes` 只增不减**：周更快照可能比上游登记慢，改小会把「共 12 集」变成「共 8 集」。
- 字段口径与 `lib/format.js#bgmToRow` 必须一致（`meta_tags` 优先、标签最多 8 个、
  `rating_total` = `score_details` 各档之和）—— 两处算得不一样，前端题材行就会跳。
- 验收在 `scripts/verify-archive.mjs`（迷你 fixture，不依赖真 dump）。

**10.7 自动更新的边界（`npm run dump`）**

- **只认 sha256**：索引 `digest` 与 `dump_state.digest` 一样就跳过下载；下载后校验不符**删文件、换镜像**，
  绝不把坏包交给导入。
- **镜像用模板**（`{url}` 占位），"直连"写成 `{url}`；`template: true` 的列表字段在保存时校验占位符
  （缺了就 400 并指出第几条），不是 http(s) 校验。
- **下载走 `.part` + `Range`**：断在哪个字节就从哪续（换镜像也按字节续）；服务器回 200（忽略 Range）
  时必须清空重下，否则拼出坏文件。
- **不解压到磁盘**：`lib/unzip.js` 只读中央目录 + `zlib.createInflateRaw`，条目流直接交给
  `readJsonLinesFrom`。zip64 / 加密 / 分卷一律明确报错（别猜）。
- **调度不阻塞队列**：worker 到点后"发射后不管"，状态进 `workerState.dump`（`/api/health` 可见）；
  失败退避 10min → 1h → 6h，且检查失败也写 `checked_at`（否则 30 秒一轮会疯狂重试）。
- **半在线必须有回全在线的兜底**：`bgm.useDump` 只是"优先用 dump"；档案缺失或 `synced_at` 超过
  `bgm.dumpMaxAgeDays` 仍现查 API。

---

## 11. 提交前自检清单

- [ ] 新代码放在正确目录，依赖方向没有反向
- [ ] 注释只讲「为什么 / 约束 / 坑」，没有试错叙事
- [ ] 没有 `console.*`，日志消息是 `模块.动作` + 结构化字段
- [ ] 新队列的 7 条语义写进了注释与本文档
- [ ] 新增配置项有默认值、注释、启动校验
- [ ] 错误码选对，`detail` 不含敏感信息
- [ ] 动了 AI：`AI_TOOLS` 清单与 `callAiTool` 实现同步，且验证脚本覆盖了「未配置」降级路径
- [ ] 有 `verify-*` 脚本或可复现命令作为证据
- [ ] 动了系列链 / 映射 / 调度：`anime` 的排期字段（`year` / `season` / `weekday`）**没被这些流程写过**（§10.3）
- [ ] 给 `anime` 加列时：`schema.sql` 与 `db/index.js` 的 `MIGRATIONS` 都改了，且**补列必须早于建表**
      （否则 schema 里给新列建索引会报 `no such column`）
- [ ] 临时文件已删，工作区干净

