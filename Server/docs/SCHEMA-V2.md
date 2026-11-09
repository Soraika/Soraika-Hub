# Schema v2 设计稿 —— 身份 / 档案 / 排期拆开

> 状态：**设计稿，未实施**。看完再决定动不动手。
> 依据：对 `data/hub.db`（3762 行）+ 全部源码做的实测审计（2026-11-09）。
> 关联：ARCHITECTURE §2（数据模型）/ §3（数据来源）、CONVENTIONS §10（系列链与映射）。

---

## 0. 一句话

现在一张 `anime` 同时装着**三件不同寿命的东西**：谁是谁（身份映射）、番剧资料（BGM 档案）、这季放什么（Mikan 排期）。
后两件都能重建，**只有映射丢了才麻烦** —— 所以拆成三张表，映射单独存。

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
| `title` | 3762 | 展示兜底、`byTitle` | Mikan 侧标题 → 留 `anime` |
| `title_cn` | 3674（88 空） | 展示优先 | BGM → 进档案表 |
| `poster_src` / `poster_path` | 3731 / 667 | 出图接口 | 留 `anime`（一个作品一张海报） |
| `score` `rating_total` `tags` `watching` `summary` `total_episodes` | 3745 / 3744 / 3555 | 卡片、详情、下载页 | BGM 档案 → 进档案表 |
| `air_date` | 3715 | 放送季兜底、剧场版排序、重排补日期 | BGM 档案 → 进档案表（`first_air_date`） |
| `year` `season` `weekday` | 1559 | **只有首页排期查询读** | Mikan 排期 → 留 `anime` |
| `source` | 3762 | **零读取**（只有 INSERT/UPDATE 在写） | **删** |
| `created_at` | 3762 | **零读取** | **删**（映射表保留一个，那里有意义） |
| `updated_at` | 3762 | 首页缓存新鲜度 `MAX(updated_at)` | 留 `anime` |
| `bgm_checked_at` | 3762 | **两个语义共用一列**：① 映射失败的 7 天退避 ② 档案刷新的分界线 | **拆成两个** |
| `bgm_miss_count` | 3680（≥3 的 50 条，`gaveUp=16`） | 队列放弃逻辑 | 搬进映射表（`misses`） |
| `series_*` 六件套 | 见表 | 归档目录、系列 chip | 留 `anime`（它是"作品之间"的关系，属于排期侧） |

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
bgm_subject    ── BGM 档案缓存（可整表删掉重灌，4 秒）
anime          ── Mikan 排期 + 展示 + 系列（可整表重建，代价是要重扫 Mikan）
```

### 3.1 `mikan_bgm_map`（身份：`mikanId ↔ bgmId`）

```sql
CREATE TABLE IF NOT EXISTS mikan_bgm_map (
  mikan_id    TEXT PRIMARY KEY,     -- Mikan 番剧 id（权威来源：Mikan 详情页）
  bgm_id      TEXT,                 -- 对不上就是 NULL（老番常常真没挂链接）
  title       TEXT,                 -- 扫描时 Mikan 的标题：给"还没排进库"的行留个名字
  misses      INTEGER DEFAULT 0,    -- 连续几次拿不到 bgm_id（原 bgm_miss_count）
  checked_at  INTEGER,              -- 上次**尝试确认映射**的时间（7 天退避用）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_map_bgm ON mikan_bgm_map(bgm_id) WHERE bgm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_map_pending ON mikan_bgm_map(misses, checked_at);
```

- **这一张表就是"数据库重构不影响的东西"**：`sqlite3 hub.db ".backup"` 或者导出 JSON 都行。
- 丢了也能重建：`npm run sweep` 重扫 5400 个 mikan id（几分钟、会打 Mikan），但没必要冒这个风险。

### 3.2 `bgm_subject`（BGM 档案缓存）

```sql
CREATE TABLE IF NOT EXISTS bgm_subject (
  bgm_id         TEXT PRIMARY KEY,
  title          TEXT,             -- BGM 原名（name）
  title_cn       TEXT,             -- BGM 中文名（name_cn）
  summary        TEXT,
  score          REAL,
  rating_total   INTEGER,
  tags           TEXT,             -- JSON 数组，最多 8 个（meta_tags 优先，与 bgmToRow 同口径）
  watching       INTEGER,
  first_air_date TEXT,             -- 原名 air_date：首播/上映日期 YYYY-MM-DD
  total_episodes INTEGER,
  synced_at      INTEGER,          -- 档案上次写入时间（**只表示档案**，不再兼职映射退避）
  source         TEXT              -- 'api' / 'dump'：这条档案从哪来的（排查用）
);
CREATE INDEX IF NOT EXISTS idx_bgm_score ON bgm_subject(score);
```

> 这里保留一个 `source`，但**语义完全不同**：原来记"这行最近一次谁写的"（没人读），
> 现在记"这条档案是 API 拿的还是 dump 灌的" —— 半在线模式下要能看出 dump 覆盖了哪些。

### 3.3 `anime`（排期 + 展示 + 系列）

```sql
CREATE TABLE IF NOT EXISTS anime (
  id              INTEGER PRIMARY KEY,   -- ← 去掉 AUTOINCREMENT（见 §1.2），前端 key，无外部含义
  mikan_id        TEXT UNIQUE,           -- 可空：系列骨架行只有 bgm_id
  bgm_id          TEXT UNIQUE,           -- 可空：Mikan 没挂链接的行
  title           TEXT,                  -- Mikan 侧标题（可空：骨架行没有）
  poster_src      TEXT,
  poster_path     TEXT,
  year            INTEGER,               -- ┐
  season          TEXT,                  -- ├ 排期：只有 Mikan 季度页写
  weekday         INTEGER,               -- ┘
  series_id       INTEGER,               -- 系列标识 = 代表行的 id
  series_index    INTEGER,               -- 第几季（番外 NULL）
  series_relation TEXT,                  -- 续集/OVA/剧场版/总集篇/衍生/其他
  naming_style    TEXT,                  -- season | volume（只写代表行）
  series_root_title TEXT,                -- 系列总名 = 归档顶层目录名（只写代表行）
  series_all_movies INTEGER,             -- 1 = 整条系列都是剧场版
  series_checked_at INTEGER,             -- 系列算过的时间（NULL 待算 / -1 处理中）
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anime_season ON anime(year, season, weekday);
CREATE INDEX IF NOT EXISTS idx_anime_series ON anime(series_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_anime_series_pos
  ON anime(series_id, series_index) WHERE series_index IS NOT NULL;
```

**`anime` 里刻意不再有的列**：`title_cn`、`score`、`rating_total`、`tags`、`watching`、`summary`、
`air_date`、`total_episodes`、`source`、`created_at`、`bgm_miss_count`、`bgm_checked_at` ——
它们要么属于档案表，要么是死列。

### 3.4 谁写什么（v2）

| 数据 | 写入方 | 目标表 | 备注 |
|---|---|---|---|
| Mikan 排期（番名/封面/星期） | 首页切季 / `sweep` | `anime` | `year/season/weekday` 只在这里写 |
| Mikan 详情页 → bgmId | 补齐①a / `sweep` | `mikan_bgm_map` | 同时写 `misses` / `checked_at` |
| BGM 档案（API） | 补齐①b / 每日更新 | `bgm_subject` | 写 `synced_at`、`source='api'` |
| BGM 档案（dump） | `npm run archive` | `bgm_subject` | 写 `synced_at`、`source='dump'`；`total_episodes` 只增不减 |
| 系列六件套 | `jobs/series.js` | `anime` | 代表行写根名 / 风格 / 判据 |
| 海报缓存 | 出图接口 | `anime` | 纯缓存，丢了自动重下 |

---

## 4. 查询怎么变（4 个真实场景）

**一句话结论**：所有场景都是「`anime` LEFT JOIN `bgm_subject`」，SQLite 在 4000 行规模上是**微秒级**，
比现在多出来的开销可以忽略；换来的是「档案可以整表重灌」。

```sql
-- ① 首页某一季（现在是 SELECT * FROM anime WHERE year=? AND season=?）
SELECT a.id, a.title, a.poster_path, a.poster_src, a.year, a.season, a.weekday,
       a.mikan_id, a.bgm_id,
       b.title_cn, b.score, b.rating_total, b.tags, b.watching, b.summary
  FROM anime a
  LEFT JOIN bgm_subject b ON b.bgm_id = a.bgm_id
 WHERE a.year = ? AND a.season = ?
 ORDER BY a.weekday, b.score IS NULL, b.score DESC, a.id;

-- ② 详情（a.id）
SELECT a.*, b.* FROM anime a LEFT JOIN bgm_subject b ON b.bgm_id = a.bgm_id WHERE a.id = ?;

-- ③ 下载页按 mikan_id 认回作品（现在 WHERE mikan_id = ?，语义不变）
SELECT a.id, a.title, b.title_cn, b.total_episodes
  FROM anime a LEFT JOIN bgm_subject b ON b.bgm_id = a.bgm_id WHERE a.mikan_id = ?;

-- ④ 「档案还缺」的统计 / 队列（现在是 score/tags/summary 任一为空）
SELECT COUNT(*) FROM anime a
  LEFT JOIN bgm_subject b ON b.bgm_id = a.bgm_id
 WHERE a.bgm_id IS NOT NULL AND (b.score IS NULL OR b.tags IS NULL OR b.summary IS NULL);
```

**展示标题**（最容易分叉的地方）v2 收成一个函数：

```
displayTitle(row) = bgm.title_cn || anime.title || bgm.title     -- 中文名 → Mikan 标题 → BGM 原名
```

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
| `src/jobs/sweep-mikan.js` | INSERT `anime` | INSERT `mikan_bgm_map`（**不再建 `anime` 行**） |
| `src/jobs/series.js` | 读 `anime` 全字段 + 写系列列 | 读 join（要 `first_air_date` / `total_episodes`）；写系列列不变 |
| `src/lib/format.js` | `bgmToRow` 产出 anime 行 | 拆成 `bgmToSubject()`（→ 档案表）+ `mikanToRow()`（→ 排期） |
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

`scripts/migrate-v2.mjs`（新脚本）在一个事务里做四件事：

```sql
-- ① 身份：anime 里所有有 mikan_id 的行 → 映射表
INSERT INTO mikan_bgm_map (mikan_id, bgm_id, title, misses, checked_at, created_at, updated_at)
SELECT mikan_id, bgm_id, title, COALESCE(bgm_miss_count, 0), bgm_checked_at, created_at, updated_at
  FROM anime WHERE mikan_id IS NOT NULL
 GROUP BY mikan_id;            -- 理论上已唯一；GROUP BY 只是防历史脏数据

-- ② 档案：所有有 bgm_id 的行 → 档案表
INSERT INTO bgm_subject (bgm_id, title, title_cn, summary, score, rating_total, tags, watching,
                         first_air_date, total_episodes, synced_at, source)
SELECT bgm_id, NULL, title_cn, summary, score, rating_total, tags, watching,
       air_date, total_episodes, bgm_checked_at, 'api'
  FROM anime WHERE bgm_id IS NOT NULL GROUP BY bgm_id;

-- ③ 排期表瘦身：anime_v1 → anime（只留 §3.3 的列）
-- ④ 对账：见 §8
```

脚本支持 `--dry-run`（只打印将写入多少行、对账差异）。

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
npm run sweep -- --limit=0                   -- 重扫 Mikan（5400 个 id，几分钟）
npm run series -- --limit=50                 -- 系列重算（要 AI，按需）
```

**这一步是 v2 的核心卖点**：以前这么干会连映射一起丢，现在不会。

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
| 三张表都存在，且 `anime` 没有档案列 | `verify-home`（结构不变式） | 结构漂移 |
| `mikan_bgm_map` 行数 = v1 里 `COUNT(DISTINCT mikan_id)` | `verify-detail` | 迁移没丢映射 |
| `bgm_subject` 行数 ≥ `COUNT(DISTINCT bgm_id)` | 同上 | 同上 |
| 首页某季条数与 v1 一致、每张卡仍有 `score/scoreText/metaText` | `verify-home` | join 没漏行 |
| 详情 18 个字段一个不少（契约不变） | `verify-detail` | 接口兼容 |
| `archive` 写的是 `bgm_subject`，且 `total_episodes` 只增不减 | `verify-archive` | 半在线模式的边界 |
| 映射队列的退避**只**看 `mikan_bgm_map.checked_at`（导入 dump 不再影响它） | `verify-worker` | 拆列后语义不串 |
| `anime.id` 连续时不再跳号（插 1 行 + 冲突 5 次 upsert → 下一条 id 只 +1） | 新脚本或 `verify-detail` | 去掉 AUTOINCREMENT 的收益 |

---

## 9. 代价与风险（先说清楚）

| 项 | 代价 | 缓解 |
|---|---|---|
| 一次改 12 个文件 + 6 个 verify | 半天到一天，且中途不能跑半套 | 分 Step 走；旧表改名留档，随时可回 |
| 首页/详情多一次 join | 实测规模下微秒级（4000 × 4000，有 `bgm_id` 唯一索引） | 需要时加 `idx_bgm_score`（已给） |
| 重建 `anime` 要重扫 Mikan | `sweep` 5400 个 id，几分钟；会打上游 | 只在真要验证"可重建"时做，日常不需要 |
| 系列重算要 AI | 3746 条 × token | 只在系列数据丢了才做；否则 `anime` 不重建 |
| 前端 `id` 在重建后会变 | 前端 key 是运行时拿的，刷新即恢复 | 页面缓存里旧 id 会 404 → 前端已有兜底（详情 404 提示） |
| `sweep` 不再建 `anime` 行 | "只有映射、没排期"的作品不再出现在库里 | **这正是想要的**：能进首页的只有 Mikan 排期页上的番 |

---

## 10. 明确不做（这个版本不动）

- **不填历史 id 空洞**（无意义，还可能撞前端缓存）。
- **不做 `anime` 与 `bgm_subject` 的触发器**（同步逻辑留在代码里，看得见）。
- **不动 qB 标签体系**（`mid:` 仍是身份，不改成 bgm id —— 换 id 会让 176 个老种子失联）。
- **不动字幕组字典**（它本来就是"随用随建"的缓存）。
- **不做多用户/多库**（v2 只解决"三件事混一张表"）。

---

## 11. 需要你拍板的三个点

1. **`title` 归属**：v2 里 `anime.title` 只放 Mikan 标题（骨架行为空），展示用
   `bgm.title_cn → anime.title → bgm.title`。可以接受吗？（现在是"一个 title 两种来源混着写"）
2. **`bgm.mode` 开关**：做成设置页的一项（`api` / `dump`），还是**只靠"有没有跑过 archive"隐式判断**？
   我倾向显式开关 —— 半在线模式下每日更新要不要还刷 API，是个明确的取舍。
3. **老表处理**：`anime_v1` 改名留档一周再 DROP（我建议这个），还是迁移成功后直接删？

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
| id 为什么跳号 | `AUTOINCREMENT` + upsert 冲突烧号（实测 5 次冲突烧 5 个）+ 早期整批删除 |
| `title` / `title_cn` | Mikan 标题 / BGM 中文名，两者不是一回事，展示优先中文名 |
| `air_date` | 首播（上映）日期，跟"排期季"不同；剧场版排序、放送季兜底靠它 |
| `source` | 零读取，删（v2 在档案表留一个"数据来源"的新语义列） |
| `created_at` | 零读取，删（映射表保留一个，那里有意义） |
| `bgm_miss_count` | 有用途但属于"映射"，搬进 `mikan_bgm_map.misses` |
| `series_*` | 见 §1.3；`series_all_movies` = 整条系列都是剧场版（AI 判 `allMovies`） |
| 数据库能重建吗 | 能：映射表保住 → `sweep` + `archive` 就能把另外两张表重建回来 |
| 自动解压 | 零依赖方案：读 zip 中央目录 + `zlib.createInflateRaw` **边解压边解析**，不落盘；再加 `--latest` 自动下载 |




