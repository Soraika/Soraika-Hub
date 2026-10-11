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
  stats: db.prepare(`
    SELECT
      COUNT(*)                                                                 AS total,
      SUM(CASE WHEN mikan_id IS NOT NULL THEN 1 ELSE 0 END)                    AS withMikan,
      SUM(CASE WHEN bgm_id IS NOT NULL THEN 1 ELSE 0 END)                      AS withBgm,
      SUM(CASE WHEN mikan_id IS NOT NULL AND bgm_id IS NULL THEN 1 ELSE 0 END) AS mikanOnly,
      SUM(CASE WHEN score IS NOT NULL THEN 1 ELSE 0 END)                       AS withScore
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
/** 按作品主键取（出图接口用） */
export const findById = (id) => stmt.byId.get(val(id)) ?? null
/** 出图接口落地本地缓存后回写路径 */
export const setPosterPath = (id, posterPath) => stmt.updatePosterPath.run(val(posterPath), Date.now(), val(id))

/** 映射/评分覆盖率统计（CLI 与排错用） */
export const stats = () => stmt.stats.get()

// ── 字幕组（实体表 + 关联表；下载页要「字幕组 → 资源列表」两级入口）────────────
//
// 为什么是两张表：字幕组本身是全站共用的字典（Kirara Fantasia 出现在 321 部作品下），
// 老结构把「作品」和「字幕组」塞进同一张表，468 部作品就攒出 1930 行重复名字。
// 现在：subgroup 存实体（全站唯一）、anime_subgroup 存关系（复合主键，不带自增 id）。
// 读的时候 JOIN 回「一行一个字幕组」的形状，而且列名沿用老的
// （subgroup_mikan_id / subgroup_rss_id）—— 上层与前端一行都不用改。

const subgroupStmt = {
  /** 实体 upsert：同一个字幕组全站只留一条，改名以最近一次抓取为准 */
  upsertEntity: db.prepare(`
    INSERT INTO subgroup (mikan_subgroup_id, name, rss_id, source, created_at, updated_at)
    VALUES (?, ?, ?, 'mikan', ?, ?)
    ON CONFLICT(mikan_subgroup_id) DO UPDATE SET
      name = excluded.name,
      rss_id = COALESCE(excluded.rss_id, subgroup.rss_id),
      updated_at = excluded.updated_at
  `),
  entityByMikanId: db.prepare('SELECT id FROM subgroup WHERE mikan_subgroup_id = ?'),

  /** 关系：某作品下有哪些字幕组；rss_id 必须按作品存（同一个组在不同作品下的 RSS id 不同） */
  clearLinks: db.prepare('DELETE FROM anime_subgroup WHERE anime_id = ?'),
  insertLink: db.prepare(`
    INSERT INTO anime_subgroup (anime_id, subgroup_id, mikan_id, rss_id, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(anime_id, subgroup_id) DO UPDATE SET
      rss_id = COALESCE(excluded.rss_id, anime_subgroup.rss_id),
      sort = excluded.sort,
      updated_at = excluded.updated_at
  `),

  /** 读：JOIN 成上层熟悉的形状（列名与老表一致，调用方无感） */
  byAnime: db.prepare(`
    SELECT s.id                 AS id,
           s.mikan_subgroup_id  AS subgroup_mikan_id,
           s.name               AS name,
           s.source             AS source,
           l.mikan_id           AS mikan_id,
           l.rss_id             AS subgroup_rss_id
    FROM anime_subgroup l
    JOIN subgroup s ON s.id = l.subgroup_id
    WHERE l.anime_id = ?
    ORDER BY l.sort ASC, s.name ASC
  `),
  countEntities: db.prepare('SELECT COUNT(*) AS n FROM subgroup'),
  countLinks: db.prepare('SELECT COUNT(*) AS n FROM anime_subgroup'),
}

/**
 * 用最新的字幕组列表覆盖某部作品的字幕组（先清关系再按顺序重建）
 * @param {number} animeId
 * @param {Array<{subgroupName:string, subgroupMikanId:string, subgroupRSSId?:string}>} subgroups
 * @param {string} mikanId
 */
export function replaceSubgroups(animeId, subgroups = [], mikanId = null) {
  db.exec('BEGIN')
  try {
    subgroupStmt.clearLinks.run(val(animeId))
    const now = Date.now()
    subgroups.forEach((sg, index) => {
      // ① 先把字幕组本身写进实体表（同一个组被 N 部作品引用时，这一步只会更新名字）
      subgroupStmt.upsertEntity.run(
        val(sg.subgroupMikanId),
        val(sg.subgroupName),
        val(sg.subgroupRSSId),
        now,
        now,
      )
      const entity = subgroupStmt.entityByMikanId.get(val(sg.subgroupMikanId))
      if (!entity) return
      // ② 再写「这部作品有这个组」的关系（sort 记上游顺序）
      subgroupStmt.insertLink.run(
        val(animeId),
        val(entity.id),
        val(mikanId),
        val(sg.subgroupRSSId),
        val(index),
        now,
        now,
      )
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return subgroups.length
}

export const listSubgroups = (animeId) => subgroupStmt.byAnime.all(val(animeId))

/** 排错/统计用：字幕组实体数（去重后）与关系数 —— 一眼看出有没有重复堆积 */
export const subgroupStats = () => ({
  entities: subgroupStmt.countEntities.get().n,
  links: subgroupStmt.countLinks.get().n,
})
