/**
 * 动漫信息检索表 repository —— 上层只调这里的函数，不直接写 SQL
 * ---------------------------------------------------------------------------
 * 「库优先」策略的落点：写库只有一个入口（upsertMany），读库也只有几个具名函数。
 * 合并规则（重要）：**补进来的字段不会被 NULL 覆盖** —— 因为首页先落 Mikan 排期
 * （此时 score/bgm_id 还是空的），评分是后台补齐的；如果 upsert 时用 NULL 覆盖，
 * 已经补好的评分会被下一次排期刷新清掉。
 */
import { config } from '../config.js'
import { db, val } from './index.js'

/** 全部列（顺序与 insert 占位符一一对应） */
const COLUMNS = [
  'mikan_id',
  'bgm_id',
  'title',
  'title_cn',
  'poster_path',
  'poster_src',
  'score',
  'rating_total',
  'tags',
  'watching',
  'summary',
  'year',
  'season',
  'weekday',
  'air_date',
  'total_episodes',
  'source',
]

const placeholders = COLUMNS.map(() => '?').join(', ')
// 注意 poster_src 的方向是**反的**：已有值优先 —— Bangumi 的封面更大（/l/ 原图），
// 不该被之后每次 Mikan 排期刷新覆盖回 Mikan 的相对路径小图。
const updateAssignments = COLUMNS.filter((c) => !['mikan_id', 'bgm_id'].includes(c))
  .map((c) =>
    c === 'poster_src'
      ? 'poster_src = COALESCE(anime.poster_src, excluded.poster_src)'
      : `${c} = COALESCE(excluded.${c}, anime.${c})`,
  )
  .join(',\n    ')

/** Mikan 排期入库：以 mikan_id 为冲突键，空缺字段不覆盖已有值 */
const upsertByMikanSql = `
INSERT INTO anime (${COLUMNS.join(', ')}, created_at, updated_at)
VALUES (${placeholders}, ?, ?)
ON CONFLICT(mikan_id) DO UPDATE SET
    ${updateAssignments},
    bgm_id = COALESCE(excluded.bgm_id, anime.bgm_id),
    updated_at = excluded.updated_at
`

/** Bangumi 侧补齐：以 bgm_id 为冲突键（只有 bgm 的条目也能先落库） */
const upsertByBgmSql = `
INSERT INTO anime (${COLUMNS.join(', ')}, created_at, updated_at)
VALUES (${placeholders}, ?, ?)
ON CONFLICT(bgm_id) DO UPDATE SET
    ${updateAssignments},
    mikan_id = COALESCE(excluded.mikan_id, anime.mikan_id),
    updated_at = excluded.updated_at
`

const stmt = {
  upsertByMikan: db.prepare(upsertByMikanSql),
  upsertByBgm: db.prepare(upsertByBgmSql),
  byId: db.prepare('SELECT * FROM anime WHERE id = ?'),
  byMikanId: db.prepare('SELECT * FROM anime WHERE mikan_id = ?'),
  byBgmId: db.prepare('SELECT * FROM anime WHERE bgm_id = ?'),
  /**
   * 按番名找（下载页用：老种子的标签丢了，只能靠归档目录名认回来）
   * 只认**完全相等**的中文名或原名 —— 模糊匹配会把「碧蓝之海」和「碧蓝之海 第二季」认错，
   * 那种错认比「认不出、归到未识别」更糟（会把两部的集数混在一起）
   */
  byTitle: db.prepare('SELECT * FROM anime WHERE title_cn = ? OR title = ? LIMIT 1'),

  bySeason: db.prepare(`
    SELECT * FROM anime
    WHERE year = ? AND season = ?
    ORDER BY weekday ASC, score IS NULL, score DESC, id ASC
  `),
  maxUpdatedAt: db.prepare('SELECT MAX(updated_at) AS t FROM anime WHERE year = ? AND season = ?'),
  countAll: db.prepare('SELECT COUNT(*) AS n FROM anime'),
  /** 只补元数据，不动排期归属（year/season/weekday 永远由 Mikan 决定） */
  updateMeta: db.prepare(`
    UPDATE anime SET
      bgm_id       = COALESCE(?, bgm_id),
      title_cn     = COALESCE(?, title_cn),
      -- 海报源换了就清掉本地缓存路径，让出图接口下次重新抓（否则会一直发旧图）
      poster_path  = CASE WHEN ? IS NOT NULL AND ? IS NOT poster_src THEN NULL ELSE poster_path END,
      poster_src   = COALESCE(?, poster_src),
      score        = COALESCE(?, score),
      rating_total = COALESCE(?, rating_total),
      tags         = COALESCE(?, tags),
      watching     = COALESCE(?, watching),
      summary      = COALESCE(?, summary),
      air_date     = COALESCE(?, air_date),
      total_episodes = COALESCE(?, total_episodes),
      source       = COALESCE(?, source),
      updated_at   = ?
    WHERE id = ?
  `),
  /** 出图接口把本地缓存路径写回来（下次直接读文件，不再打上游） */
  updatePosterPath: db.prepare('UPDATE anime SET poster_path = ?, updated_at = ? WHERE id = ?'),
  /**
   * 出图接口回写图源（现场问 Bangumi 拿到的封面 / 换过源）与本地缓存路径
   * 两个值都是 COALESCE 语义：传 null 不覆盖已有值 —— 只想改一个就只传一个
   */
  updatePosterSource: db.prepare(`
    UPDATE anime SET
      poster_src  = COALESCE(?, poster_src),
      poster_path = COALESCE(?, poster_path),
      updated_at  = ?
    WHERE id = ?
  `),
  stats: db.prepare(`
    SELECT
      COUNT(*)                                                                 AS total,
      SUM(CASE WHEN mikan_id IS NOT NULL THEN 1 ELSE 0 END)                    AS withMikan,
      SUM(CASE WHEN bgm_id IS NOT NULL THEN 1 ELSE 0 END)                      AS withBgm,
      SUM(CASE WHEN mikan_id IS NOT NULL AND bgm_id IS NULL THEN 1 ELSE 0 END) AS mikanOnly,
      SUM(CASE WHEN score IS NOT NULL THEN 1 ELSE 0 END)                       AS withScore,
      -- 有 bgm_id 但档案还空着的（评分/标签/简介任一为空）→ 触发④「档案补齐」的目标
      SUM(CASE WHEN bgm_id IS NOT NULL AND (score IS NULL OR tags IS NULL OR summary IS NULL)
               THEN 1 ELSE 0 END)                                              AS needArchive
    FROM anime
  `),
}

/**
 * 批量 upsert（Mikan 排期入库）
 * @param {Array<object>} rows 每个对象含 COLUMNS 里的字段（缺的用 null）
 * @returns {{ inserted: number, touched: number }}
 */
export function upsertManyFromMikan(rows = []) {
  if (!rows.length) return { inserted: 0, touched: 0 }
  const before = stmt.countAll.get().n
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      const now = Date.now()
      stmt.upsertByMikan.run(...COLUMNS.map((c) => val(row[c])), now, now)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { inserted: stmt.countAll.get().n - before, touched: rows.length }
}

/**
 * 把 Bangumi 的评分/标签补到记录上
 * 已有的记录**按 id 更新**（不能走 upsert：mikan_id 已存在时，用 bgm_id 做冲突键会撞
 * mikan_id 的唯一索引）；表里没有对应记录时才插入（必须带 title，由调用方从 Mikan 侧带过来）。
 */
export function applyBgmMeta(row) {
  const existing =
    (row.mikan_id && stmt.byMikanId.get(val(row.mikan_id))) ||
    (row.bgm_id && stmt.byBgmId.get(val(row.bgm_id))) ||
    null

  if (!existing) {
    if (!row.title) throw new Error('applyBgmMeta：新建记录必须带 title')
    const now = Date.now()
    stmt.upsertByBgm.run(...COLUMNS.map((c) => val(row[c])), now, now)
    return { id: stmt.byBgmId.get(val(row.bgm_id))?.id ?? null, created: true }
  }

  stmt.updateMeta.run(
    val(row.bgm_id),
    val(row.title_cn),
    val(row.poster_src), // CASE：新海报地址非空 …
    val(row.poster_src), // CASE：… 且与原地址不同 → 清掉本地缓存
    val(row.poster_src), // poster_src 本体
    val(row.score),
    val(row.rating_total),
    val(row.tags),
    val(row.watching),
    val(row.summary),
    val(row.air_date),
    val(row.total_episodes),
    val(row.source),
    Date.now(),
    existing.id,
  )
  return { id: existing.id, created: false }
}

/** 取某季全部条目（按星期、评分排序） */
export const listBySeason = (year, season) => stmt.bySeason.all(val(year), val(season))

/** 该季最近一次写入时间（缓存新鲜度判定） */
export const maxUpdatedAt = (year, season) => stmt.maxUpdatedAt.get(val(year), val(season))?.t ?? 0

/** 全库条目数（排错/统计用） */
export const countAll = () => stmt.countAll.get().n

export const findByMikanId = (mikanId) => stmt.byMikanId.get(val(mikanId)) ?? null
export const findByBgmId = (bgmId) => stmt.byBgmId.get(val(bgmId)) ?? null
/** 按番名（中文名或原名，完全相等）找 —— 下载页把老种子认回作品用 */
export const findByTitle = (title) => stmt.byTitle.get(val(title), val(title)) ?? null
/** 按作品主键取（出图接口用） */
export const findById = (id) => stmt.byId.get(val(id)) ?? null
/** 出图接口落地本地缓存后回写路径 */
export const setPosterPath = (id, posterPath) => stmt.updatePosterPath.run(val(posterPath), Date.now(), val(id))

/** 只写首播日期（系列重排前补日期用：不打乱排期归属 year/season） */
export const updateAirDate = (id, date) =>
  db.prepare('UPDATE anime SET air_date = ?, updated_at = ? WHERE id = ?').run(val(date), Date.now(), val(id))

/**
 * 出图接口回写图源与缓存路径（任一传 null = 不改那一项）
 * 两处用到：① 现场问 Bangumi 拿到封面 → 把 `poster_src` 存下来（这条上游请求一辈子只花一次）
 *          ② 回源成功落盘 → 把本地文件名存下来
 */
export const setPosterSource = (id, { src = null, path = null } = {}) =>
  stmt.updatePosterSource.run(val(src), val(path), Date.now(), val(id))

/** 映射/评分覆盖率统计（CLI 与排错用） */
export const stats = () => stmt.stats.get()

// ── 字幕组字典（只存 id → 名字；「哪个作品有哪些组」**不存**，每次现取）────────────
//
// 为什么只留字典：Mikan 详情页（`GET /Home/Bangumi/{mikanId}`）一页就带着
// 「字幕组 + 各自的 RSS id」，面板打开时现取即可。而「(作品, 字幕组) → RSS id」这个映射
// **本来就不该当长期数据**：同一个组在不同作品下的 RSS id 是不同的（实测 37 / 488 / 422）。
// 字典的用处：拿到 mikan_subgroup_id 能显示名字，以后按组筛选/排序有个稳定对照。

const subgroupStmt = {
  /** 字典 upsert：同一个字幕组全站只留一条，改名以最近一次抓取为准 */
  upsertEntity: db.prepare(`
    INSERT INTO subgroup (mikan_subgroup_id, name, rss_id, source, created_at, updated_at)
    VALUES (?, ?, ?, 'mikan', ?, ?)
    ON CONFLICT(mikan_subgroup_id) DO UPDATE SET
      name = excluded.name,
      rss_id = COALESCE(excluded.rss_id, subgroup.rss_id),
      updated_at = excluded.updated_at
  `),
  countEntities: db.prepare('SELECT COUNT(*) AS n FROM subgroup'),
  /** 全部组名（去重字典）—— 详情页 404 时给 AI 一份「可选组名」清单 */
  listDict: db.prepare('SELECT name FROM subgroup ORDER BY name'),
}

/**
 * 把这一批字幕组记进字典（只记身份与名字，**不记**「哪个作品有它」）
 * ---------------------------------------------------------------------------
 * 面板每打开一次就会调一次 → 字典自动保持新鲜；它只是名字缓存，写失败也不影响功能。
 * @param {Array<{subgroupName:string, subgroupMikanId:string, subgroupRSSId?:string}>} subgroups
 */
export function rememberSubgroups(subgroups = []) {
  if (!subgroups.length) return 0
  const now = Date.now()
  db.exec('BEGIN')
  try {
    for (const sg of subgroups) {
      if (!sg?.subgroupMikanId) continue
      subgroupStmt.upsertEntity.run(
        val(sg.subgroupMikanId),
        val(sg.subgroupName),
        val(sg.subgroupRSSId),
        now,
        now,
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return subgroups.length
}

/** 字典里有多少个字幕组（排错用） */
export const countSubgroupDict = () => subgroupStmt.countEntities.get()?.n ?? 0

/** 字典里的全部组名（去重）—— 详情页 404 时交给 AI 当「可选组名」清单 */
export const listSubgroupDict = () => subgroupStmt.listDict.all().map((r) => r.name)

// ── 系列链（后台走 BGM 关系算出来的产物；下载归档目录要用）──────────────────
//
// 存储口径（与 CONVENTIONS.md §10.2 一致）：
//   · series_id        = 「代表行」的 id —— 我们自己的主键，同一系列同一个值
//   · series_index     = 链位（1,2,3…）；番外为 NULL
//   · series_relation  = **归一后的绝对类别**（不是 BGM 的原始 relation ——
//                        那个是「相对当前条目」的，实测 LOST GIRLS 在 S1 是番外篇、在 S2/S3 是衍生）
//   · naming_style / series_root_title 只写在**代表行**上（改根名/改风格只改一行）
//
// 这一层只做「存 / 取」：走链、AI 归一、算 naming_style 都在 jobs/ 与 lib/ 里。

const seriesStmt = {
  /** 写系列字段 —— 参照 updateMeta 的写法：传 null 的字段不会覆盖库里已有的值 */
  updateMeta: db.prepare(`
    UPDATE anime SET
      series_id         = COALESCE(?, series_id),
      series_index      = COALESCE(?, series_index),
      series_relation   = COALESCE(?, series_relation),
      naming_style      = COALESCE(?, naming_style),
      series_root_title = COALESCE(?, series_root_title),
      series_all_movies = COALESCE(?, series_all_movies),
      series_checked_at = COALESCE(?, series_checked_at),
      updated_at        = ?
    WHERE id = ?
  `),
  /** 同系列成员：正传按链位在前，番外（series_index 为 NULL）在后 */
  bySeries: db.prepare(`
    SELECT * FROM anime
    WHERE series_id = ?
    ORDER BY series_index IS NULL, series_index ASC, id ASC
  `),
  /** 清掉整个系列的季位（重排前用；有部分唯一索引，必须先清再写） */
  clearPositions: db.prepare('UPDATE anime SET series_index = NULL WHERE series_id = ? AND series_index IS NOT NULL'),
  /**
   * 链位写入：**覆盖**语义（不用 COALESCE）
   * ---------------------------------------------------------------------------
   * 为什么必须覆盖：走链时补进「缺的头部」（骨架行）之后，所有成员的季位都要往后挪一位。
   * 若沿用 COALESCE，老值会留着 → 骨架行和新头两个都拿到 index=1（实测就会这样）。
   */
  updatePosition: db.prepare(`
    UPDATE anime SET
      series_id         = COALESCE(?, series_id),
      series_index      = ?,
      series_relation   = ?,
      series_checked_at = COALESCE(?, series_checked_at),
      updated_at        = ?
    WHERE id = ?
  `),
  /**
   * 骨架行：只有 bgm_id + 名字（**没有 mikan_id / 年份 / 季度**）
   * 冲突就什么都不做（已经存在说明这条本来就在库）—— 由调用方再读回来。
   */
  insertStub: db.prepare(`
    INSERT INTO anime (bgm_id, title, title_cn, source, series_checked_at, created_at, updated_at)
    VALUES (?, ?, ?, 'bgm', ?, ?, ?)
    ON CONFLICT(bgm_id) DO NOTHING
  `),
}

/**
 * 写一部作品的系列信息（只传要更新的字段；传 null 不覆盖已有值）
 * @param {number} id 作品主键
 * @param {{ seriesId?:number, seriesIndex?:number|null, seriesRelation?:string,
 *           namingStyle?:string, seriesRootTitle?:string, seriesAllMovies?:number,
 *           seriesCheckedAt?:number }} [meta]
 */
export function setSeriesMeta(id, meta = {}) {
  const now = Date.now()
  return seriesStmt.updateMeta.run(
    val(meta.seriesId),
    val(meta.seriesIndex),
    val(meta.seriesRelation),
    val(meta.namingStyle),
    val(meta.seriesRootTitle),
    val(meta.seriesAllMovies),
    val(meta.seriesCheckedAt ?? now),
    now,
    val(id),
  )
}

/** 同系列的全部作品（正传在前、按链位；番外在后） */
export const listSeriesMembers = (seriesId) => seriesStmt.bySeries.all(val(seriesId))

/**
 * 清掉整个系列的季位（重排前必须先清：季位上有部分唯一索引，直接改会撞约束）
 * @returns {number} 清掉的行数
 */
export const resetSeriesPositions = (seriesId) => seriesStmt.clearPositions.run(val(seriesId)).changes

/**
 * 这条作品所在的系列是不是「整条都是剧场版」（AI 判定，标志存在代表行上）
 * 用途：档案补齐刚写进 `air_date` 时触发一次重排 —— 剧场版系列就是按上映日期排的，
 * 早补晚补都能对回原位。
 * @returns {number|null} 是的话返回 series_id，否则 null
 */
export function isMovieOnlySeries(rowId) {
  const row = stmt.byId.get(val(rowId))
  if (!row?.series_id) return null
  const rep = stmt.byId.get(val(row.series_id))
  return Number(rep?.series_all_movies) === 1 ? row.series_id : null
}

/**
 * 写链位（**覆盖** `series_index` / `series_relation`）
 * ---------------------------------------------------------------------------
 * 与 `setSeriesMeta`（COALESCE、不覆盖）分工：
 *   · 根名 / 命名风格 / 番外 → `setSeriesMeta`（谁都不许把已有根名抹掉）
 *   · 正传链位 → 这里（链上补进新的头部后，季位必须整体重排，不能保留旧值）
 * @param {number} id
 * @param {{ seriesId?:number, seriesIndex?:number|null, seriesRelation?:string|null, seriesCheckedAt?:number }} [meta]
 */
export function setSeriesPosition(id, meta = {}) {
  const now = Date.now()
  return seriesStmt.updatePosition.run(
    val(meta.seriesId),
    meta.seriesIndex ?? null,
    meta.seriesRelation ?? null,
    val(meta.seriesCheckedAt),
    now,
    val(id),
  )
}

/**
 * 建「骨架行」：链上确实存在、但我们库里没有的成员（BGM 有、Mikan 没有条目）
 * ---------------------------------------------------------------------------
 * 为什么必须建：系列链只把**已在库**的成员写进系列，所以缺了第一季时，
 * 后面的季位会整体前移（S02 变成"第一个"→ 用户看到"没有 S1"）。实测《死神 千年血战篇》：
 * 上游 前传 → bgm=1600《BLEACH》(2004，Mikan 赛季页对 2004 返回空壳，扫不到) → 库里没有。
 * 骨架行只有 `bgm_id` + 名字（`mikan_id` 为空）→
 *   · 不会进首页排期（排期按 year/season 过滤，骨架行两者都空）
 *   · 会被「档案补齐」队列自动补上评分/标签/简介（触发①b 的谓词就是 bgm_id 有、档案缺）
 *   · 资源区为空（Mikan 上它本来就没有条目）—— 面板显示「这部暂时没有资源」
 * `series_checked_at` 直接写成当前时间：它已经在**本次**走链里被处理，不该再排一次队。
 * @param {{ bgmId:string, title?:string|null, titleCn?:string|null, seriesCheckedAt?:number }} params
 * @returns {object|null} 落库后的行（已存在则返回已有行）
 */
export function ensureBgmStub({ bgmId, title, titleCn = null, seriesCheckedAt = null } = {}) {
  const id = String(bgmId ?? '').trim()
  if (!id) return null
  const existing = stmt.byBgmId.get(val(id))
  if (existing) return existing
  const now = Date.now()
  const name = String(title ?? '').trim() || `BGM ${id}`
  seriesStmt.insertStub.run(val(id), val(name), val(titleCn), val(seriesCheckedAt ?? now), now, now)
  return stmt.byBgmId.get(val(id)) ?? null
}

/**
 * 按 bgm_id 批量取「库里已有哪些」—— 走链时用它判断链上成员是否已在库
 * ---------------------------------------------------------------------------
 * IN 列表长度不固定，所以这条 SQL 是**动态拼**的（与上面那些固定 stmt 不同）；
 * 调用频率很低（一次算系列调一次），不值得为它引入预处理缓存。
 * @param {Array<string|number>} bgmIds
 */
export function findByBgmIds(bgmIds = []) {
  const ids = [...new Set(bgmIds.filter((v) => v !== null && v !== undefined && v !== '').map(String))]
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  return db
    .prepare(`SELECT id, bgm_id, title, title_cn, series_id, series_index, series_relation,
                     naming_style, series_root_title, series_all_movies, air_date, year, season
                FROM anime WHERE bgm_id IN (${placeholders})`)
    .all(...ids.map((v) => val(v)))
}
