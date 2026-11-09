-- ============================================================================
-- Soraika's Hub —— 数据库结构
-- ----------------------------------------------------------------------------
-- 约定：
--   1. id 是**作品主键**，由本表自增生成 —— 接口里给前端的 `item.id` 就是它
--      （前端 utils/orderKey.js 明确要求「主键由后端给，不用来源 id」）
--   2. mikan_id / bgm_id 是**来源 id**，各自唯一、都可空：
--        · 首页排期来自 Mikan → 先落 mikan_id，bgm_id 由后台补齐
--        · 只从 Bangumi 拿到的条目也能先落库
--   3. 时间戳统一用毫秒整数（JS Date.now()），跨语言/跨库都好处理
-- ============================================================================

-- ── 排期表：首页 / 发现 / 搜索 / 下载页都读它（**不再存档案**） ──────────────
-- 档案（评分/标签/简介/放送日/集数/平台/原名）在 `bgm_subject`，身份映射在 `mikan_bgm_map`。
-- 重建这张表只丢排期：映射与档案都能各自恢复（见 docs/SCHEMA-V2.md）。
-- id 不再 AUTOINCREMENT：upsert 命中冲突时不会烧号（实测旧表烧掉 8500 个号）。
CREATE TABLE IF NOT EXISTS anime (
  id                INTEGER PRIMARY KEY,  -- 接口给前端的 id；无外部含义
  mikan_id          TEXT,                 -- 来源：Mikan（排期主源）
  bgm_id            TEXT,                 -- 来源：Bangumi（档案去 bgm_subject 取）
  title_mikan       TEXT,                 -- Mikan 侧标题（骨架行为空）
  poster_path       TEXT,                 -- 本地缓存后的相对路径（出图接口写它）
  poster_src        TEXT,                 -- 原始海报地址（出图接口读它）
  year              INTEGER,              -- 放送年份（只有 Mikan 写）
  season            TEXT,                 -- 放送季度：春 / 夏 / 秋 / 冬（只有 Mikan 写）
  weekday           INTEGER,              -- 0=周日 … 6=周六；7=剧场版；8=OVA（只有 Mikan 写）

  -- ── 系列链（后台走 BGM 关系算出来的产物；下载归档目录要用，见 CONVENTIONS.md §10.1/§10.2）──
  series_id         INTEGER,
  series_index      INTEGER,
  series_relation   TEXT,
  naming_style      TEXT,
  series_root_title TEXT,
  series_checked_at INTEGER,
  series_all_movies INTEGER,

  -- 补齐簿记（档案队列/每日更新的退避窗口）
  bgm_checked_at    INTEGER,
  updated_at        INTEGER NOT NULL  -- 缓存新鲜度判定用它
);

-- 两个来源各自唯一（可空列在 SQLite 里不参与唯一冲突，所以「只有一边」也能共存）
CREATE UNIQUE INDEX IF NOT EXISTS idx_anime_mikan ON anime(mikan_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_anime_bgm   ON anime(bgm_id);
-- 首页按「年 + 季 + 星期」取整季
CREATE INDEX IF NOT EXISTS idx_anime_season ON anime(year, season, weekday);
-- 系列：查「同系列有哪些作品」
CREATE INDEX IF NOT EXISTS idx_anime_series ON anime(series_id);

-- ── 读取视图：排期 + 档案拼成一行（读代码不用到处写 JOIN） ──────────────────
-- 名字保留 `air_date` 这类旧名：前端契约与映射层不关心它是哪张表给的。
CREATE VIEW IF NOT EXISTS v_anime AS
SELECT a.id, a.mikan_id, a.bgm_id, a.title_mikan, a.poster_path, a.poster_src,
       a.year, a.season, a.weekday,
       a.series_id, a.series_index, a.series_relation, a.naming_style,
       a.series_root_title, a.series_checked_at, a.series_all_movies,
       a.bgm_checked_at, a.updated_at,
       b.title_bgm, b.title_bgm_origin, b.summary, b.score, b.rating_total,
       b.tags, b.watching, b.platform, b.first_air_date AS air_date,
       b.total_episodes, b.synced_at
  FROM anime a
  LEFT JOIN bgm_subject b ON b.bgm_id = a.bgm_id;

-- ============================================================================
-- ============================================================================
-- 字幕组字典（**只存身份，不存"哪个作品有它"**）
-- ----------------------------------------------------------------------------
-- 变更：原先还有一张 `anime_subgroup`（作品 ↔ 字幕组 + **该作品下的 RSS id**），已删除。
-- 理由：那个映射**每次都能现取** —— 面板打开时抓一次 Mikan 详情页
-- `GET /Home/Bangumi/{mikanId}` 就带着「字幕组 + 各自的 RSS id」；前端拿到 id 后
-- 取资源时回传即可（`/api/anime/:id/releases?subgroupId=<该作品下的 rssId>`），
-- 服务端不必再存一份（实测同一个组在不同作品下 rss_id 不同：千夏 37 / 488 / 422）。
-- 留这张表只为一件事：**名字字典** —— 有了 mikan_subgroup_id 就能显示名字，
-- 以后要按字幕组筛选/排序也有个稳定的 id → 名字对照。因为不存关系，不会有旧结构的重复。
-- 数据可重建：面板每打开一次，就把见到的组 upsert 回来。
-- ============================================================================
CREATE TABLE IF NOT EXISTS subgroup (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  mikan_subgroup_id TEXT NOT NULL,   -- 字幕组在 Mikan 的 id（全站唯一，去重键）
  name              TEXT NOT NULL,   -- 最新名字（上游改名以最近一次抓取为准）
  rss_id            TEXT,            -- 最近一次见到的 RSS id（仅供参考；取资源以现取的为准）
  source            TEXT DEFAULT 'mikan',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subgroup_mikan ON subgroup(mikan_subgroup_id);


-- ============================================================================
-- 设置表：设置页改过的配置项（key → JSON 值）
-- ----------------------------------------------------------------------------
-- 为什么存库而不是 JSON 文件：
--   · API 进程和独立 worker（npm run worker）都会读配置，JSON 文件两处并发写会互相覆盖；
--     库有事务/写锁（WAL 已开），批量改也是原子的
--   · 只存**用户改过的项**，不是全量快照：没改的继续吃 .env / 默认值，
--     所以以后新增配置项，老库不会因为「缺这个键」而出错
-- 分享 / 迁移走导出：导出成 JSON 文件（默认脱敏），导入即合并 —— 存储用库不影响分享用文件
-- ============================================================================
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,      -- 值的 JSON 表示（字符串/数字/布尔都包一层，读时 JSON.parse）
  updated_at INTEGER NOT NULL
);

-- ============================================================================
-- 离线 dump 的导入状态（单行表）
-- ----------------------------------------------------------------------------
-- 只为一件事：**决定"要不要下载"**。索引里 `digest` 和这里一样 → 直接结束（省 450MB）。
-- 同时兼作设置页的状态展示（最近检查/当前版本/上次导入）。
-- 它不是配置（配置在 settings），而是"这台机器上次导了哪一版"的运行状态。
-- ============================================================================
CREATE TABLE IF NOT EXISTS dump_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  name        TEXT,          -- dump 文件名（dump-2026-11-03.210402Z.zip）
  digest      TEXT,          -- sha256（索引里给的那个）
  size        INTEGER,       -- 压缩包大小（字节）
  source_url  TEXT,          -- 实际下载用的地址（排查镜像问题用）
  checked_at  INTEGER,       -- 上次检查索引的时间
  imported_at INTEGER        -- 上次成功导入的时间
);

-- ============================================================================
-- Mikan ↔ Bangumi 身份映射（**唯一不可重建的东西**，单独一张表）
-- ----------------------------------------------------------------------------
-- 为什么拆出来：`anime` 是"排期 + 展示"的产物，随时可以重建（重新扫 Mikan）；
-- 而「哪个 mikan_id 对应哪个 bgm_id」丢了就得重扫几千个页面才能捡回来。
-- 拆开之后：重建 anime 不影响映射，备份也只需要带走这一张表。
--
-- 字段：
--   checked_at  上次**尝试确认映射**的时间。没有 bgm 链接的（老番常见）隔 30 天再试，
--               不再记"失败了几次"——有没有链接是事实，不是失败次数。
-- ============================================================================
CREATE TABLE IF NOT EXISTS mikan_bgm_map (
  mikan_id    TEXT PRIMARY KEY,      -- Mikan 番剧 id（权威来源：Mikan 详情页）
  bgm_id      TEXT,                  -- 对不上就是 NULL
  title_mikan TEXT,                  -- 扫描/排期时 Mikan 的标题（给还没进 anime 的行留个名字）
  checked_at  INTEGER,               -- 上次尝试确认映射的时间（NULL = 还没试过）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_map_bgm ON mikan_bgm_map(bgm_id) WHERE bgm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_map_pending ON mikan_bgm_map(checked_at) WHERE bgm_id IS NULL;

-- ============================================================================
-- Bangumi 档案缓存（称号/评分/标签/简介/放送日/集数/平台）
-- ----------------------------------------------------------------------------
-- 为什么单独一张表：这些字段**每周都会被 dump 整份覆盖**（`npm run dump`），
-- 而 `anime` 是"排期 + 展示"的产物（重建一次要重扫 Mikan）。拆开之后：
--   · 档案可以整表清空重灌（4 秒），不碰排期
--   · 重建 anime 不丢档案（下一步读取改 JOIN 之后）
-- `total_episodes` 由导入侧保证**只增不减**（周更快照可能落后于上游登记）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS bgm_subject (
  bgm_id            TEXT PRIMARY KEY,
  title_bgm         TEXT,            -- name_cn（缺就填原名）
  title_bgm_origin  TEXT,            -- name（日文/罗马字，详情页「原名」用）
  summary           TEXT,
  score             REAL,
  rating_total      INTEGER,
  tags              TEXT,            -- JSON 数组（meta_tags 优先，最多 8 个）
  watching          INTEGER,
  platform          INTEGER,         -- 1=TV 2=OVA 3=剧场版 5=Web（dump 的 platform 码）
  first_air_date    TEXT,            -- YYYY-MM-DD
  total_episodes    INTEGER,
  synced_at         INTEGER,         -- 档案上次写入时间（**只表示档案**）
  source            TEXT             -- 'api' / 'dump'
);
CREATE INDEX IF NOT EXISTS idx_subject_score ON bgm_subject(score);

-- ============================================================================
-- 以下表结构已按架构图设计好，但本次还没做到，做到对应功能时再启用。
-- ----------------------------------------------------------------------------
-- 下载任务表（记录的是「后端操作的整个生命周期」，不是任务本身的生命周期）
--   id, torrent_hash(索引), title, bgm_id, mikan_id, subgroup_name, subgroup_id,
--   state(待处理/等待ai返回/等待重命名/等待元数据/暂停/失败/完成/文件丢失),
--   fail_reason, total_episodes, download_episodes, created_at, updated_at
--
-- RSS 订阅队列表
--   id, title, mikan_id, bgm_id, auto_mode(最新优先/字幕组优先/自定义),
--   priority_json(字幕组优先级 → 字幕类型 → 分辨率 → 优先修订版 v2)
--
-- AI 结果缓存表（标签解析 / 重命名，独立表便于清理）
--   id, key, kind(tag|rename), provider, model, prompt_hash, result, created_at
--
-- 设置表已启用，见文件上方 settings 表
-- ============================================================================
