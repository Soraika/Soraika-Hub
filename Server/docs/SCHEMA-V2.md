# Schema v2 设计稿 —— 身份 / 档案 / 排期拆开

> 状态：**设计稿 v2.1，未实施**。看完再决定动不动手。
> v2.1（2026-11-09 第二轮）：`title` 改名为 `_mikan`/`_bgm`；删掉映射的 `misses` 计数，
> 改成尾部扫描；删掉 `series_all_movies`（改用 `platform`）；根名改成"点开才算"。
> 依据：对 `data/hub.db`（3762 行）+ 全部源码 + 2026-11-03 dump 的实测审计（2026-11-09）。
> 关联：ARCHITECTURE §2（数据模型）/ §3（数据来源）、CONVENTIONS §10（系列链与映射）。

---

## 0. 一句话

现在一张 `anime` 同时装着**三件不同寿命的东西**：谁是谁（身份映射）、番剧资料（BGM 档案）、这季放什么（Mikan 排期）。
后两件都能重建，**只有映射丢了才麻烦** —— 所以拆成三张表（+ 一张扫描水位），映射单独存。

---

## 1. 现状盘点（实测，不是印象）

### 1.1 数量与空洞

```
行数 3762 · id 1 … 12295 · 空洞 8533 个（344 段）· sqlite_sequence 已到 12753
```

| 大段空洞 | 大小 | 推测来源 |
|---|---|---|
| 8150–9733 | 1584 | 早期整批删除/重建 |
| 3338–4418 | 1081 | 同上 |
| 764–1405 | 642 | 同上 |
| 1411–1889 | 479 | 同上 |
| 2864–3336 | 473 | 同上 |

这 5 段占了 4259 个，剩下 **4274 个是散落的单号** —— 那部分有确定答案：

### 1.2 id 为什么跳号（对照实验）

`id INTEGER PRIMARY KEY AUTOINCREMENT` + 每次刷季用 `INSERT … ON CONFLICT DO UPDATE`：

```
AUTOINCREMENT（现状）        1 行数据、5 次冲突 upsert 后 → 下一条新行 id = 7
INTEGER PRIMARY KEY（v2）    1 行数据、5 次冲突 upsert 后 → 下一条新行 id = 2
```

SQLite 是**先分配 rowid、再发现冲突转 UPDATE**：号被烧掉、行没增加。切一次季 upsert 77 条、绝大多数命中冲突 → 每轮烧几十个号，几年下来就是几千个洞。

**结论**：空洞不影响任何功能（`id` 只是前端 key；qB 标签写的是 `mid:{mikan_id}`）。v2 去掉 `AUTOINCREMENT` 后这种洞不再产生；已经存在的洞**不修**（修了反而会让在用的前端缓存 key 错位）。

### 1.3 每列的读写方（谁写 / 谁读 / 判定）

| 列 | 填充 | 读它的地方 | 判定 |
|---|---|---|---|
| `mikan_id` | 3256 | 排期、详情、下载页认回作品 | **身份①** → 进映射表 |
| `bgm_id` | 3746 | 档案、系列、外链 | **身份②** → 进映射表 |
| `title` | 3762 | 展示兜底、`byTitle` | Mikan 侧标题 → `anime.title_mikan` |
| `title_cn` | 3674（88 空） | 展示优先 | BGM → `bgm_subject.title_bgm`（另存 `title_bgm_origin` 原名） |
| `poster_src` / `poster_path` | 3731 / 667 | 出图接口 | 留 `anime`（一个作品一张海报） |
| `score` `rating_total` `tags` `watching` `summary` `total_episodes` | 3745 / 3744 / 3555 | 卡片、详情、下载页 | BGM 档案 → 进档案表 |
| `air_date` | 3715 | 放送季兜底、剧场版排序、重排补日期 | BGM 档案 → 进档案表（`first_air_date`） |
| `year` `season` `weekday` | 1559 | **只有首页排期查询读** | Mikan 排期 → 留 `anime` |
| `source` | 3762 | **零读取**（只有 INSERT/UPDATE 在写） | **删** |
| `created_at` | 3762 | **零读取** | **删**（映射表保留一个，那里有意义） |
| `updated_at` | 3762 | 首页缓存新鲜度 `MAX(updated_at)` | 留 `anime` |
| `bgm_checked_at` | 3762 | **两个语义共用一列**：① 映射失败退避 ② 档案刷新分界线 | **拆成两个**：`map.checked_at` / `subject.synced_at` |
| `bgm_miss_count` | 3680（≥3 的 50 条，`gaveUp=16`） | 队列放弃逻辑 | **删**（连 `misses` 也不要）→ 尾部扫描 + 连续 200 未命中即停 |
| `series_all_movies` | 16 | 剧场版系列重排 | **删** → `platform === 3`（确定性） |
| `series_checked_at` | 3746 | 系列队列 | **拆两个**：`series_chain_at`（链）/ `series_named_at`（AI 起名） |

### 1.4 现有结构真正的三个问题

1. **身份与资料混在一起**：`anime` 一行既表示"这部番存在"，又表示"我们抓到过它的资料"。所以 `bgmOnly=506` 的骨架行、`mikanOnly=16` 的空档案行都只能硬塞进同一张表，档案列全空。
2. **一列两用**：`bgm_checked_at` 既是"映射尝试时间"又是"档案刷新时间"。档案导入（`npm run archive`）写它会**顺带**把映射队列的退避也改掉 —— 现在没出事只是因为你没在两者之间踩线。
3. **可重建的东西和不可重建的东西同生共死**：重建 `anime` = 同时丢掉映射（`sweep` 重扫 5400 个 id 才能捡回来）。

---

## 2. 目标：只支持两种数据模式

| 模式 | Mikan（排期/资源/字幕组） | BGM（评分/标签/简介/集数/日期） | 说明 |
|---|---|---|---|
| **全在线** | 实时 | **API 实时** | 现在默认的样子 |
| **半在线** | 实时 | **离线 dump**（周更，`npm run archive`） | 你刚导入的那套；API 只在"缺了才补"时打 |

- **不存在全离线**：Mikan 没有离线数据源（排期/资源/RSS 都是网页）。
- 模式是**全局开关**（`bgm.mode = 'api' | 'dump'`），不是每行的字段 —— 两种模式下**读取路径完全一样**（都读档案表），只有"谁往里写"不同。
- `dump` 模式下的行为：档案优先用 dump；`synced_at` 为空的行才打 API；每日更新不再全量刷 API。

---

## 3. v2 结构：三张表

```
mikan_bgm_map  ── 身份（唯一不可重建 / 可单独备份）
mikan_scan     ── 扫描水位（单行；掉了只是多扫一次）
bgm_subject    ── BGM 档案缓存（可整表删掉重灌，4 秒）
anime          ── Mikan 排期 + 展示 + 系列（可整表重建，代价是扫一遍尾部）
```

### 3.1 `mikan_bgm_map`（身份：`mikanId ↔ bgmId`）

```sql
CREATE TABLE IF NOT EXISTS mikan_bgm_map (
  mikan_id    TEXT PRIMARY KEY,     -- Mikan 番剧 id（权威来源：Mikan 详情页）
  bgm_id      TEXT,                 -- 对不上就是 NULL（老番常常真没挂链接）
  title_mikan TEXT,                 -- 扫描时 Mikan 的标题：给"还没排进库"的行留个名字
  checked_at  INTEGER,              -- 上次**尝试确认映射**的时间（只做慢速重试，见 §3.2）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_map_bgm ON mikan_bgm_map(bgm_id) WHERE bgm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_map_pending ON mikan_bgm_map(checked_at) WHERE bgm_id IS NULL;
```

- **这一张表就是"数据库重构不影响的东西"**：`sqlite3 hub.db ".backup"` 或者导出 JSON 都行。
- **没有 `misses` 计数**（原 `bgm_miss_count` 删掉）：一个 mikanId 有没有 bgm 链接是**事实**，
  不是"失败了几次"；用计数去猜"要不要再试"本身就是补丁。改成下面这套扫描策略。

### 3.2 映射的维护方式（放弃全量扫描）

Mikan 的动画 id 是**递增**的，新番只会在尾部出现；老 id 大量是 404（页面本来就不存在）。
所以不需要"遍历 183~4124 再逐条放弃"：

```sql
-- 扫描水位（单行表；也可以塞进 settings，但它是运行状态，不是用户配置）
CREATE TABLE IF NOT EXISTS mikan_scan (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  watermark     INTEGER NOT NULL,   -- 已经确认过的最大 mikan id
  updated_at    INTEGER NOT NULL
);
```

| 任务 | 做法 | 频率 |
|---|---|---|
| **尾部扫描**（主要） | 从 `watermark + 1` 往后逐个 `GET /Home/Bangumi/{id}`，命中就写 `mikan_bgm_map`；**连续 N 个 404/无标题就停**（默认 N=200，可配）→ 说明还没到下一季，`watermark` 前移到最后确认的 id | 每天一次（新番上线当天就能进库） |
| **空洞补扫**（次要） | 对 `watermark` 以内、`mikan_bgm_map` 里没有的 id 只跑一遍（已知 183~4124 区间，实测缺口不多） | 手动 / 每周一次 |
| **慢速重试** | `bgm_id IS NULL AND (checked_at IS NULL OR checked_at < now - 30d)` 的再试一次（万一 Mikan 后来补了链接） | 每周 |
| **季度扫描**（保底） | 切季时首页本来就会抓该季全部番 → 顺手写映射 + 建排期行 | 切季时天然发生 |

好处：**日常只有"往后几十个 id"的请求量**，而不是 5400 个；也不会因为一堆死 id 天天重试。

### 3.3 `bgm_subject`（BGM 档案缓存）

```sql
CREATE TABLE IF NOT EXISTS bgm_subject (
  bgm_id            TEXT PRIMARY KEY,
  title_bgm         TEXT,             -- BGM 中文名（name_cn），没有就存原名 → 展示用
  title_bgm_origin  TEXT,             -- BGM 原名（name），日文/罗马字 → 详情页"原名"
  summary           TEXT,
  score             REAL,
  rating_total      INTEGER,
  tags              TEXT,             -- JSON 数组，最多 8 个（meta_tags 优先，与 bgmToRow 同口径）
  watching          INTEGER,
  platform          INTEGER,          -- 平台码：1=TV 2=OVA 3=剧场版 5=Web（见 §3.4）
  first_air_date    TEXT,             -- 原名 air_date：首播/上映日期 YYYY-MM-DD
  total_episodes    INTEGER,
  synced_at         INTEGER,          -- 档案上次写入时间（**只表示档案**，不再兼职映射退避）
  source            TEXT              -- 'api' / 'dump'：这条档案从哪来的（排查用）
);
CREATE INDEX IF NOT EXISTS idx_bgm_score ON bgm_subject(score);
```

> 这里保留一个 `source`，但**语义完全不同**：原来记"这行最近一次谁写的"（没人读），
> 现在记"这条档案是 API 拿的还是 dump 灌的" —— 半在线模式下要能看出 dump 覆盖了哪些。

### 3.4 `platform` 替换 `series_all_movies`（实测证据）

dump 里 `type=2`（动画）的 `platform` 分布（2026-11-03 全量扫）：

| 码 | 含义 | 条数 | 样本 |
|---|---|---|---|
| 1 | TV | 9788 | Code Geass 反叛的鲁路修R2 / 机动战士高达 / CLANNAD |
| 2 | OVA | 4219 | 皇家国教骑士团 OVA / 黑客帝国动画版 / 柯赛特的肖像 |
| 3 | **剧场版** | 6603 | 攻壳机动队 / 穿越时空的少女 / **哆啦A梦剧场版全部（id 425/436/437…）** |
| 5 | Web | 4822 | 亡念之扎姆德 / 黑塔利亚 / 小凉宫春日的忧郁 |
| 0 | 未填 | 5717 | —— |
| 2006 | 其他/番外 | 148 | 私立堀镡学园 番外篇 / 声优战队 |

所以「整条系列都是剧场版」**不用 AI 判**：`系列所有成员的 platform = 3` 就是。
`series_all_movies` 列删掉；判定放在 `lib/series.js` 里一个纯函数：

```js
const allMovies = members.length > 0 && members.every((m) => m.platform === 3)
```

兜底顺序（全在线模式下 API 可能不给 platform）：`platform=3 全体` → 没有正传且关系全是番外 → 才可选地问 AI。

### 3.5 `anime`（排期 + 展示 + 系列）

```sql
CREATE TABLE IF NOT EXISTS anime (
  id              INTEGER PRIMARY KEY,   -- ← 去掉 AUTOINCREMENT（见 §1.2），前端 key，无外部含义
  mikan_id        TEXT UNIQUE,           -- 可空：系列骨架行只有 bgm_id
  bgm_id          TEXT UNIQUE,           -- 可空：Mikan 没挂链接的行
  title_mikan     TEXT,                  -- Mikan 侧标题（可空：骨架行没有）
  poster_src      TEXT,
  poster_path     TEXT,
  year            INTEGER,               -- ┐
  season          TEXT,                  -- ├ 排期：只有 Mikan 季度页写
  weekday         INTEGER,               -- ┘
  series_id       INTEGER,               -- 系列标识 = 代表行的 id
  series_index    INTEGER,               -- 第几季（番外 NULL）
  series_relation TEXT,                  -- 续集/OVA/剧场版/总集篇/衍生/其他
  naming_style    TEXT,                  -- season | volume（只写代表行）
  series_root_title TEXT,                -- 系列总名 = 归档顶层目录名（只写代表行；**AI 按需补**）
  series_chain_at INTEGER,               -- 链/季位算过的时间（确定性，批量跑；NULL 待算 / -1 处理中）
  series_named_at INTEGER,               -- 根名/命名风格补过的时间（AI，点开系列时才算）
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anime_season ON anime(year, season, weekday);
CREATE INDEX IF NOT EXISTS idx_anime_series ON anime(series_id);
CREATE INDEX IF NOT EXISTS idx_anime_series_named ON anime(series_named_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_anime_series_pos
  ON anime(series_id, series_index) WHERE series_index IS NOT NULL;
```

**两个系列时间戳**取代原来一个 `series_checked_at`：

| 列 | 谁写 | 代价 | 策略 |
|---|---|---|---|
| `series_chain_at` | `jobs/series.js`（后台） | 无 AI，只读 BGM 关系 | 全量预计算（便宜） |
| `series_named_at` | 点开系列时（AI 起名） | 要 token、要等模型 | **按需**：NULL 表示还没起名，前端先显示兜底名 |

**`anime` 里刻意不再有的列**：`title_cn`、`score`、`rating_total`、`tags`、`watching`、`summary`、
`air_date`、`total_episodes`、`source`、`created_at`、`bgm_miss_count`、`bgm_checked_at`、
**`series_all_movies`**、`series_checked_at` —— 要么属于档案表，要么是死列，要么被确定性判据/按需补齐取代。

### 3.6 谁写什么（v2）

| 数据 | 写入方 | 目标表 | 备注 |
|---|---|---|---|
| Mikan 排期（番名/封面/星期） | 首页切季 / 季度扫描 | `anime` | `year/season/weekday` 只在这里写 |
| Mikan 详情页 → bgmId | 尾部扫描 / 空洞补扫 / 切割季 | `mikan_bgm_map` | 写 `checked_at`（不写命中计数） |
| BGM 档案（API） | 补齐 / 每日更新 | `bgm_subject` | 写 `synced_at`、`source='api'` |
| BGM 档案（dump） | `npm run archive` | `bgm_subject` | 写 `synced_at`、`source='dump'`；`total_episodes` 只增不减 |
| 系列链 / 季位 / 类别 | `jobs/series.js` | `anime` | 确定性；写 `series_chain_at` |
| 根名 / 命名风格 | 点开系列时（详情接口触发） | `anime` | AI；写 `series_named_at`；失败不阻塞详情返回 |
| 海报缓存 | 出图接口 | `anime` | 纯缓存，丢了自动重下 |

---

## 4. 查询怎么变（4 个真实场景）

**一句话结论**：所有场景都是「`anime` LEFT JOIN `bgm_subject`」，SQLite 在 4000 行规模上是**微秒级**，
比现在多出来的开销可以忽略；换来的是「档案可以整表重灌」。

```sql
-- ① 首页某一季（现在是 SELECT * FROM anime WHERE year=? AND season=?）
SELECT a.id, a.title_mikan, a.poster_path, a.poster_src, a.year, a.season, a.weekday,
       a.mikan_id, a.bgm_id,
       b.title_bgm, b.score, b.rating_total, b.tags, b.watching
  FROM anime a
  LEFT JOIN bgm_subject b ON b.bgm_id = a.bgm_id
 WHERE a.year = ? AND a.season = ?
 ORDER BY a.weekday, b.score IS NULL, b.score DESC, a.id;

-- ② 详情（a.id）
SELECT a.*, b.* FROM anime a LEFT JOIN bgm_subject b ON b.bgm_id = a.bgm_id WHERE a.id = ?;

-- ③ 下载页按 mikan_id 认回作品（现在 WHERE mikan_id = ?，语义不变）
SELECT a.id, a.title_mikan, b.title_bgm, b.total_episodes
  FROM anime a LEFT JOIN bgm_subject b ON b.bgm_id = a.bgm_id WHERE a.mikan_id = ?;

-- ④ 「档案还缺」的统计 / 队列（现在是 score/tags/summary 任一为空）
SELECT COUNT(*) FROM anime a
  LEFT JOIN bgm_subject b ON b.bgm_id = a.bgm_id
 WHERE a.bgm_id IS NOT NULL AND (b.score IS NULL OR b.tags IS NULL OR b.summary IS NULL);
```

**展示标题**（最容易分叉的地方）v2 收成一个函数，列名直接体现来源：

```
displayTitle({ title_bgm, title_mikan, title_bgm_origin })
  = title_bgm（BGM 中文名） || title_mikan（Mikan 标题） || title_bgm_origin（BGM 原名）

titleOriginal = title_bgm_origin 与 displayTitle 不同时才有值   -- 详情页那行小字
```

放 `lib/format.js`，**只此一处**；前端继续不拼字符串（Web CONVENTIONS §11）。
`anime.title` / `anime.title_cn` 这两个"看不出是谁的"列名就此消失。

### 4.1 系列根名：改成"点开才算"

| | 现在（v1） | v2 |
|---|---|---|
| 触发 | 后台 `jobs/series.js` 对 3746 条**全量**跑，每条都可能调 AI | 后台只算**确定性**的链/季位/类别；根名与命名风格**点开系列时**才调 AI |
| 代价 | 全量 AI = 几千次调用、几千次失败重试 | 只有用户真看过的那几十个系列花 token |
| 库里的标志 | `series_checked_at` 一个字段兼两件事 | `series_chain_at`（算过链）+ `series_named_at`（起过名） |
| 没算过时显示 | 没有根名 → 归档目录名退化成番名 | 同一套兜底（`代表行的标题`），前端不用知道 |

详情接口的行为：**先把系列列表返回给前端**（链/季位已在库里），
若 `series_named_at IS NULL` 再异步/后续请求补一次 AI 起名 —— 起名失败不影响打开面板。
归档目录用到根名时（加种）如果还没起过名，先按兜底名建目录，起名后再改名（现有 `archiveDirOf` 已支持）。

放 `lib/format.js`，**只此一处**；前端继续不拼字符串（Web CONVENTIONS §11）。

---

## 5. 代码迁移清单

| 文件 | 现在做什么 | v2 怎么改 |
|---|---|---|
| `src/db/schema.sql` | 单表 28 列 | 三张表（§3） |
| `src/db/index.js` | `MIGRATIONS` 补列 | 改成"v2 检测 + 建表"；旧的 `anime` 表**改名留档**（`anime_v1`）而不是 DROP |
| `src/db/anime.js` | 22 列 upsert、`applyBgmMeta`、`applyArchiveBatch`、`stats` | 拆三个文件：`db/map.js`（身份）、`db/subject.js`（档案）、`db/anime.js`（排期+系列）；`stats()` 改成 join 统计 |
| `src/db/queue.js` | 四条队列的谓词 + CAS | ①a 改查 `mikan_bgm_map`；①b/② 改查 `bgm_subject.synced_at`；③ 不变 |
| `src/api/pages/home.js` | 读 `anime` | 加 join（§4-①） |
| `src/api/pages/anime.js`（详情）/ `downloads.js` | 读 `anime` | 加 join（§4-②③） |
| `src/jobs/enrich.js` | 一条流程写两种表 | `applySubject()` 写 `bgm_subject`；映射写 `mikan_bgm_map` |
| `src/jobs/import-archive.js` | 写 `anime` 九列 | 写 `bgm_subject`（同一套 `archivePatch`，目标表换掉） |
| `src/jobs/sweep-mikan.js` | INSERT `anime`（全量 183~4124） | 改名 `scan-mikan.js`：**尾部扫描 + 连续 200 个 404 即停 + 水位**（§3.2），只写 `mikan_bgm_map` |
| `src/jobs/series.js` | 一条流程：走链 + AI 起名 + 落库 | 拆两半：`runSeriesChain()`（确定性，写 `series_chain_at`）/ `nameSeries()`（AI，点开时调，写 `series_named_at`）；`allMovies` 改用 `platform === 3` |
| `src/api/pages/anime.js`（详情） | 返回系列列表 | 返回时若 `series_named_at IS NULL` → 起名请求走单独的轻接口（不阻塞详情） |
| `src/lib/series.js` | `parseSeriesAnswer` 里读 `allMovies` | 增 `isAllMovies(members)`（platform 判据），AI 只负责 `rootTitle` / `namingStyle` |
| `src/lib/format.js` | `bgmToRow` 产出 anime 行 | 拆成 `bgmToSubject()`（→ 档案表）+ `mikanToRow()`（→ 排期）+ `displayTitle()` |
| `src/jobs/import-archive.js` | 写 `anime` 九列 | 写 `bgm_subject`（同一套 `archivePatch`，目标表换掉，再加 `platform` / `title_bgm_origin`） |
| `scripts/verify-*.mjs`（6 个） | 直接查 `anime` 的断言 | 改成查三张表；新增 §8 的对账断言 |

**不改的**：前端（`Web/` 一行都不用动 —— 接口契约不变）、qB 相关（`mid:{mikan_id}` 照旧）、
`settings` 表、字幕组字典。

---

## 6. 迁移步骤（可中断、可回滚）

### Step 0 · 备份（1 分钟，必做）

```bash
cd Server
sqlite3 data/hub.db ".backup data/hub.v1-backup.db"     # 或直接复制 hub.db + -wal/-shm 三件套（先停服务）
npm run archive -- --dir=<dump> --no-checked             # 顺便确认 dump 还在，能立刻重灌
```

### Step 1 · 建新表 + 回填（不改读取方，随时可回退）

`scripts/migrate-v2.mjs`（新脚本）在一个事务里做五件事：

```sql
-- ① 身份：anime 里所有有 mikan_id 的行 → 映射表（不再带 misses 计数）
INSERT INTO mikan_bgm_map (mikan_id, bgm_id, title_mikan, checked_at, created_at, updated_at)
SELECT mikan_id, bgm_id, title, bgm_checked_at, created_at, updated_at
  FROM anime WHERE mikan_id IS NOT NULL
 GROUP BY mikan_id;            -- 理论上已唯一；GROUP BY 只是防历史脏数据

-- ② 档案：所有有 bgm_id 的行 → 档案表
--    title_bgm / title_bgm_origin：v1 只有「Mikan 标题」和「BGM 中文名」两列，原名没存过，
--    所以 origin 先留空，下次 `npm run archive` 会一起灌进来（dump 里有 name）
INSERT INTO bgm_subject (bgm_id, title_bgm, title_bgm_origin, summary, score, rating_total,
                         tags, watching, platform, first_air_date, total_episodes, synced_at, source)
SELECT bgm_id, title_cn, NULL, summary, score, rating_total,
       tags, watching, NULL, air_date, total_episodes, bgm_checked_at, 'api'
  FROM anime WHERE bgm_id IS NOT NULL GROUP BY bgm_id;

-- ③ 排期表瘦身：只留 §3.5 的列
--    title → title_mikan；series_checked_at →（有 root_title 的算 chain_at，其余置 NULL 重算）
--    series_all_movies 直接丢弃：下次走链用 platform 判

-- ④ 扫描水位：watermark = 当前库里最大的 mikan_id
INSERT INTO mikan_scan (id, watermark, updated_at)
SELECT 1, COALESCE(MAX(CAST(mikan_id AS INTEGER)), 0), ? FROM anime;

-- ⑤ 对账：见 §8
```

脚本支持 `--dry-run`（只打印将写入多少行、对账差异）。
`platform` / `title_bgm_origin` 这两列在 v1 里没有，迁移后跑一次 Step 3 就补齐了。

### Step 2 · 切读取（一次性改完，别边跑边改）

按 §5 清单改代码；`npm run verify` 全绿才算切完。这期间**旧表 `anime_v1` 还在**，
出问题 `git revert` + 把 `anime_v1` 改回 `anime` 就行。

### Step 3 · 重灌档案（4 秒，验证半在线模式）

```bash
npm run archive -- --dir=<dump>        # 现在写的是 bgm_subject
```

对账结果应与 Step 1 完回填后一致（`withScore` 不变、`synced_at` 变新）。

### Step 4 · 重建排期侧（可选，验证"可重建"真的成立）

```bash
sqlite3 data/hub.db "DELETE FROM anime;"     -- 只删排期侧，映射/档案不动
npm run scan                                 -- 尾部扫描 + 空洞补扫（不是 5400 个全量）
npm run series -- --chain-only               -- 只算链/季位（不调 AI）
```

**这一步是 v2 的核心卖点**：以前这么干会连映射一起丢，现在不会；
而且重建只花"扫几十~几百个 id"的代价，不再是 5400 次请求。

### Step 5 · 归档旧表

确认跑一周没问题后：

```bash
sqlite3 data/hub.db "ALTER TABLE anime_v1 RENAME TO anime_v1_archive;"   -- 或 DROP
```

---

## 7. 回滚（三档）

| 情况 | 怎么回 |
|---|---|
| 只改了一半代码 | `git revert` + 把 `anime_v1` 改回 `anime`（`DROP TABLE anime; ALTER TABLE anime_v1 RENAME TO anime;`），映射/档案表留着也无害 |
| 数据写坏了 | 停服务 → 用 Step 0 的 `hub.v1-backup.db` 整个覆盖（`hub.db`/`-wal`/`-shm` 三件一起删了再放） |
| 只想回"全在线" | 设置页把 `bgm.mode` 改回 `api`，dump 数据留在 `bgm_subject` 里不影响（只是不再刷新） |

**不可逆的点只有一个**：`anime_v1` 被 DROP 之后。所以 Step 5 我建议隔一周再做。

---

## 8. 验收断言（要加到 verify 里）

| 断言 | 放哪 | 钉什么 |
|---|---|---|
| 三张表 + `mikan_scan` 都存在，且 `anime` 没有档案列 / 没有 `series_all_movies` | `verify-home`（结构不变式） | 结构漂移 |
| `mikan_bgm_map` 行数 = v1 里 `COUNT(DISTINCT mikan_id)` | `verify-detail` | 迁移没丢映射 |
| `bgm_subject` 行数 ≥ `COUNT(DISTINCT bgm_id)` | 同上 | 同上 |
| 首页某季条数与 v1 一致、每张卡仍有 `score/scoreText/metaText` | `verify-home` | join 没漏行 |
| 详情 18 个字段一个不少（契约不变），`titleOriginal` 来自 `title_bgm_origin` | `verify-detail` | 接口兼容 + 改名没漏 |
| `archive` 写的是 `bgm_subject`（含 `platform` / `title_bgm_origin`），`total_episodes` 只增不减 | `verify-archive` | 半在线模式的边界 |
| 映射重试**只**看 `mikan_bgm_map.checked_at`（导入 dump 不影响它），且没有 `misses` 列 | `verify-worker` | 拆列后语义不串 |
| 尾部扫描：连续 N 个 404 就停、`watermark` 前移（用假 fetch 驱动） | `verify-worker`（或新脚本） | 别把"还没到下一季"扫成 5000 次请求 |
| 全剧场版判据：`members.every(platform === 3)` → 番外也占季位（不调 AI） | `verify-detail` | platform 取代 `series_all_movies` |
| 点开系列：`series_named_at IS NULL` 时详情**先返回**、起名失败不影响 | `verify-detail` | 按需起名不阻塞 |
| `anime.id` 不再跳号（插 1 行 + 冲突 5 次 upsert → 下一条 id 只 +1） | 新脚本或 `verify-detail` | 去掉 AUTOINCREMENT 的收益 |

---

## 9. 代价与风险（先说清楚）

| 项 | 代价 | 缓解 |
|---|---|---|
| 一次改 14 个文件 + 7 个 verify | 一天左右，且中途不能跑半套 | 分 Step 走；旧表改名留档，随时可回 |
| 首页/详情多一次 join | 实测规模下微秒级（4000 × 4000，有 `bgm_id` 唯一索引） | 需要时加 `idx_bgm_score`（已给） |
| 映射改成尾部扫描 | 万一某次断网/连续 404 判断错，`watermark` 可能推进过头 | 停的条件是"连续 N 个"，且 `watermark` 只推到最后**确认存在**的 id；空洞补扫兜底 |
| 系列根名改成按需 | 第一次点开某系列会多等一次模型（2~5 秒） | 详情先返回（链/季位已就绪），起名异步补；失败不阻塞，下次点开再试 |
| 系列重算不再全量 | 老系列可能一直没有根名 | 用兜底名（代表行标题）建目录；真要统一命名就跑一次批量 `--name-all`（可选） |
| 前端 `id` 在重建后会变 | 前端 key 是运行时拿的，刷新即恢复 | 页面缓存里旧 id 会 404 → 前端已有兜底（详情 404 提示） |
| 扫描不再建 `anime` 行 | "只有映射、没排期"的作品不再出现在库里 | **这正是想要的**：能进首页的只有 Mikan 排期页上的番 |

---

## 10. 明确不做（这个版本不动）

- **不填历史 id 空洞**（无意义，还可能撞前端缓存）。
- **不做全量映射扫描**（183~4124 逐个扫 5400 次）：尾部扫描 + 空洞补扫就够，老 id 大量是 404。
- **不做 `misses` 计数 / 每条退避**：有没有 bgm 链接是事实，不是失败次数（§3.1）。
- **不做 `anime` 与 `bgm_subject` 的触发器**（同步逻辑留在代码里，看得见）。
- **不动 qB 标签体系**（`mid:` 仍是身份，不改成 bgm id —— 换 id 会让 176 个老种子失联）。
- **不动字幕组字典**（它本来就是"随用随建"的缓存）。
- **不做多用户/多库**（v2 只解决"三件事混一张表"）。

---

## 11. 决策记录（已定 / 待定）

### 已定（按你的意见）

| # | 决定 | 理由 |
|---|---|---|
| 1 | `title` → **`title_mikan`**、`title_cn` → **`title_bgm`**（另存 `title_bgm_origin` 原名） | 两列来自两个源，名字里就该带源，不叫 `_cn` 这种"看起来像语言标记"的名字 |
| 2 | **取消 `misses`**，改成尾部扫描 + 连续 200 个未命中即停 + 30 天慢速重试 | 有没有 bgm 链接是事实；新番只在尾部出现，老 id 大量 404，计数退避是补丁 |
| 3 | 映射表**不做全量维护**，靠"切季天然扫描 + 每日尾部扫描" | 数量不多、开销极小，没必要养一个 5400 次的遍历任务 |
| 4 | **取消 `series_all_movies`**，用 `platform === 3` 判 | 实测哆啦A梦剧场版全部 `platform=3`，确定性、不用 AI |
| 5 | 根名 / 命名风格**不再全量补**，改成点开系列时问 AI | 很多系列压根不同根；全量跑几千次 AI 又慢又贵，且大部分没人看 |
| 6 | 系列时间戳拆成 `series_chain_at`（确定性）+ `series_named_at`（AI） | 一列两用是 v1 的老毛病（和 `bgm_checked_at` 同款） |

### 待定（还差三句）

1. **`bgm.mode` 开关**：显式设置项（`api` / `dump`）还是隐式（跑过 archive 就算半在线）？
   我仍倾向显式 —— 半在线模式下"每日更新还刷不刷 API"是个明确取舍。
2. **老表处理**：`anime_v1` 改名留档一周再 DROP（建议），还是迁移成功后直接删？
3. **`title_bgm_origin` 要不要**：BGM 原名（日文/罗马字）现在详情页会当"原名"显示。
   如果觉得多余，可以只留 `title_bgm`（中文名，缺了就填原名）。

---

## 12. 自动下载 + 自动解压（`--latest`）设计

目标：一条命令完成 **找最新版 → 下载 → 解压 → 导入**，全程不把 1.3GB 落到磁盘上。

```bash
npm run archive -- --latest               # 半在线周更：自动拿最新 dump 并导入
npm run archive -- --latest --keep-zip    # 顺便留一份 zip（想归档/重放）
npm run archive -- --url=<直链>           # 认某个特定版本
npm run archive -- --dir=<解压目录>       # 手动模式（现在这套，保留）
```

### 12.1 找最新版

```
GET https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json
→ { browser_download_url, name, size, digest: "sha256:…", created_at }
```

`digest` 用来**下载后校验**（GitHub API 给的 sha256），校验失败直接报错、不导入 —— 
半在线模式下"档案错了"比"没导入"更糟。

### 12.2 零依赖解 zip（不落盘）

```
createReadStream(zip) ──► 定位 EOCD（末尾 64KB 内搜 PK\x05\x06）
                        ──► 读中央目录（条目名 / 压缩方式 / 压缩后大小 / 本地头偏移）
                        ──► 只取 subject.jsonlines 与 episode.jsonlines
                        ──► 按本地头偏移 createReadStream({start,end}) + zlib.createInflateRaw
                        ──► 喂给现有的 readJsonLines（逐行回调，内存恒定）
```

要点：

| 点 | 做法 |
|---|---|
| 压缩方式 | 只认 `0`(store) / `8`(deflate)；别的直接报「请手动解压后用 --dir」 |
| zip64 | 遇到就明确报错（450MB 用不到；真遇到说明改版了，别猜） |
| CRC32 | 可选校验（`zlib.crc32`，Node 20+ 有）：只对导入的行数/字节数做兜底统计 |
| 内存 | 块式 inflate（4MB 一块）+ 逐行回调，峰值 ≈ 一块 + 半行 |
| 失败姿势 | 下载/解压任一步失败 → 打印「可以用 --dir 指向已解压目录」的退路，绝不半截写库 |

**为什么不装第三方 unzip**：和当初选 `node:sqlite` 而不是 `better-sqlite3` 是同一个理由 ——
零原生依赖、装机不卡在编译；我们要的只是"两个 deflate 条目"，`zlib` 就够。

### 12.3 验收（不依赖真 dump）

`scripts/verify-archive.mjs` 里用 `zlib.deflateRawSync` **现造一个迷你 zip**（一条 store、一条 deflate），
断言：`--latest` 的解析路径能把两条都读出来、CRC 对得上、坏 zip 报错且不写库。

---

## 附：一句话对照表（v1 → v2）

| 你问的 | 答案 |
|---|---|
| id 为什么跳号 | `AUTOINCREMENT` + upsert 冲突烧号（实测 5 次冲突烧 5 个）+ 早期整批删除；v2 去掉 AUTOINCREMENT，历史空洞不修 |
| `title` / `title_cn` | 改成 **`title_mikan`**（Mikan 标题）与 **`title_bgm`**（BGM 中文名），另存 `title_bgm_origin`（原名） |
| `air_date` | 首播（上映）日期，跟"排期季"不同；剧场版排序、放送季兜底靠它（v2 叫 `first_air_date`，在档案表） |
| `source` | 零读取，删（v2 在档案表留一个"数据来源"的新语义列） |
| `created_at` | 零读取，删（映射表保留一个，那里有意义） |
| `bgm_miss_count` | 直接删（连 `misses` 也不要）：改成尾部扫描 + 连续 200 未命中即停 + 30 天慢速重试 |
| `series_all_movies` | 删：`platform === 3` 就是全剧场版（实测哆啦A梦 33 部全为 3），不用 AI |
| `series_root_title` | 不再全量补：点开系列时才让 AI 起名（`series_named_at`），失败用兜底名 |
| 数据库能重建吗 | 能：映射表保住 → `npm run scan`（只扫尾部/空洞）+ `archive` 就能重建另外两张表 |
| 自动解压 | 零依赖方案：读 zip 中央目录 + `zlib.createInflateRaw` **边解压边解析**，不落盘；再加 `--latest` 自动下载 |




