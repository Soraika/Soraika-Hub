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

-- ── 动漫信息检索表：全站事实表（首页 / 发现 / 搜索 / 下载页都读它） ──────
CREATE TABLE IF NOT EXISTS anime (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- ← 接口给前端的 id
  mikan_id       TEXT,             -- 来源：Mikan（排期主源）
  bgm_id         TEXT,             -- 来源：Bangumi（评分 / 评分人数 / 标签）
  title          TEXT NOT NULL,    -- 番名（Mikan 侧给的是中文名）
  title_cn       TEXT,             -- 中文名（Bangumi name_cn）
  poster_path    TEXT,             -- 本地缓存后的相对路径（出图接口写它）
  poster_src     TEXT,             -- 原始海报地址（出图接口读它）
  score          REAL,             -- 评分（Bangumi rating.score）
  rating_total   INTEGER,          -- 评分人数（Bangumi rating.total）
  tags           TEXT,             -- 标签，JSON 数组（给「标签解析 AI」+ 拼题材行）
  watching       INTEGER,          -- 在看人数（Bangumi collection.doing；题材缺失时用它拼文案）
  summary        TEXT,             -- 简介（下载页侧栏）
  year           INTEGER,          -- 放送年份
  season         TEXT,             -- 放送季度：春 / 夏 / 秋 / 冬
  weekday        INTEGER,          -- 0=周日 … 6=周六；7=剧场版；8=OVA（与 Mikan WeekDay 一致）
  air_date       TEXT,             -- 首播日期 YYYY-MM-DD（Bangumi date / Mikan 详情）
  total_episodes INTEGER,          -- 总集数（下载页「已下载 / 总集数」）
  source         TEXT,             -- 最近一次写入的来源：mikan / bgm / manual
  bgm_checked_at INTEGER,          -- 最后一次「补齐/刷新档案」的时间（每日更新的分界依据）
  bgm_miss_count INTEGER,          -- 连续几次拿不到 bgmId（Mikan 详情页没挂链接）—— 超限后不再频繁重试

  -- ── 系列链（后台走 BGM 关系算出来的产物；下载归档目录要用，见 CONVENTIONS.md §10.1/§10.2）──
  series_id         INTEGER,       -- 系列标识 = 代表行的 id（我们自己的主键；同一系列同一个值）
  series_index      INTEGER,       -- 链位 1,2,3…（正传 = 第几季）；番外为 NULL
  series_relation   TEXT,          -- 归一后的绝对类别：续集 / OVA / 剧场版 / 总集篇 / 衍生 / 其他
                                   -- 为什么不存 BGM 的原始 relation：它是「相对当前条目」的
                                   -- （实测 LOST GIRLS 在 S1 是「番外篇」、在 S2/S3 是「衍生」），直接存会随入口变
  naming_style      TEXT,          -- season（同名续季 → S01）/ volume（异名平行作 → 01 名字）；只写代表行
  series_root_title TEXT,          -- 系列总名（顶层目录名）；只写代表行
  series_checked_at INTEGER,       -- 算过系列信息的时间；NULL = 待算

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL  -- 缓存新鲜度判定用它
);

-- 两个来源各自唯一（可空列在 SQLite 里不参与唯一冲突，所以「只有一边」也能共存）
CREATE UNIQUE INDEX IF NOT EXISTS idx_anime_mikan ON anime(mikan_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_anime_bgm   ON anime(bgm_id);
-- 首页按「年 + 季 + 星期」取整季；发现页/搜索页按评分排序
CREATE INDEX IF NOT EXISTS idx_anime_season ON anime(year, season, weekday);
CREATE INDEX IF NOT EXISTS idx_anime_score  ON anime(score);
-- 系列：查「同系列有哪些作品」
CREATE INDEX IF NOT EXISTS idx_anime_series ON anime(series_id);

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
