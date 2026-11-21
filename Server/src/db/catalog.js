/**
 * 全站动画目录的查询层 —— 搜索 / 推荐 / 标签云
 * ---------------------------------------------------------------------------
 * 为什么单独一个模块：`db/subject.js` 是「一行档案怎么读写」，这里是「一堆档案怎么挑」。
 * 挑法全是动态条件（有没有传年份、要不要排除已入库、标签几个），SQL 只能拼；
 * 拼 SQL 的地方集中在一处，才好保证**参数一律走占位符**（拼接的只有固定片段）。
 *
 * 数据来自 `bgm_subject`（dump 里 type=2 全量落库，实测 31312 行）+ `bgm_tag` 倒排。
 * 一条上游请求都不用发 —— 这也是「离线数据全量入库」的意义：
 * agent 问「2020 年以后评分 8 以上的机战番」时，答案在本地 3 万行里，不在别人的接口里。
 */
import { db } from './index.js'

/** 季度 → 月份（BGM / Mikan 的口径：冬=1-3 月，春=4-6，夏=7-9，秋=10-12） */
const SEASON_MONTHS = {
  冬: [1, 2, 3],
  春: [4, 5, 6],
  夏: [7, 8, 9],
  秋: [10, 11, 12],
  winter: [1, 2, 3],
  spring: [4, 5, 6],
  summer: [7, 8, 9],
  autumn: [10, 11, 12],
  fall: [10, 11, 12],
}

const PLATFORM_NAMES = { 1: 'TV', 2: 'OVA', 3: '剧场版', 5: 'Web' }

/** 排序方式 → SQL 片段（白名单，绝不把外部字符串拼进 SQL） */
const ORDERS = {
  score: 's.score DESC, s.rating_total DESC',
  rank: 'CASE WHEN s.bgm_rank IS NULL THEN 1 ELSE 0 END, s.bgm_rank ASC',
  newest: 's.first_air_date DESC',
  oldest: 's.first_air_date ASC',
  popular: "COALESCE(CAST(json_extract(s.favorite, '$.done') AS INTEGER), 0) DESC",
  eps: 's.total_episodes DESC',
}

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.trunc(v))) : dflt
}

function safeJson(raw, fallback) {
  try {
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/** 一行档案 → 给 agent / 前端用的紧凑对象（字段名与 anime 接口保持同一套习惯） */
export function toCatalogRow(row, { withSummary = false } = {}) {
  if (!row) return null
  const out = {
    bgmId: row.bgm_id,
    title: row.title_bgm || row.title_bgm_origin || '',
    titleOrigin: row.title_bgm_origin || null,
    score: row.score ?? null,
    ratingTotal: row.rating_total ?? null,
    rank: row.bgm_rank ?? null,
    airDate: row.first_air_date || null,
    year: row.first_air_date ? Number(String(row.first_air_date).slice(0, 4)) : null,
    episodes: row.total_episodes ?? null,
    platform: PLATFORM_NAMES[row.platform] || null,
    tags: row.tags ? safeJson(row.tags, []) : [],
    inSeries: row.in_series === 1,
    nsfw: row.nsfw === 1,
    inLibrary: Boolean(row.lib_id),
    libraryId: row.lib_id ?? null,
  }
  if (withSummary) {
    out.summary = row.summary || null
    out.aliases = row.aliases ? safeJson(row.aliases, []) : []
    out.staff = row.staff ? safeJson(row.staff, {}) : {}
    out.favorite = row.favorite ? safeJson(row.favorite, {}) : {}
    out.scoreDetails = row.score_details ? safeJson(row.score_details, {}) : {}
    out.tagsAll = row.tags_all ? safeJson(row.tags_all, []) : []
  }
  return out
}

/**
 * 搜索全站动画
 * @param {object} q
 * @param {string} [q.query] 题名 / 别名 / 简介里的关键词（不区分大小写，子串匹配）
 * @param {number} [q.year] 放送年份
 * @param {string} [q.season] 冬/春/夏/秋
 * @param {string} [q.tag] 单个标签（必须带）
 * @param {string[]} [q.tags] 多个标签（都要带，交集）
 * @param {number} [q.minScore] 评分下限
 * @param {number} [q.maxScore] 评分上限
 * @param {number} [q.maxEps] 话数上限（想找短番）
 * @param {string} [q.platform] TV / OVA / 剧场版 / Web
 * @param {boolean} [q.inLibrary] true = 只要库里已有的；false = 只要库里没有的
 * @param {boolean} [q.includeNsfw] 默认排除 R18
 * @param {'score'|'rank'|'newest'|'oldest'|'popular'|'eps'} [q.order]
 * @param {number} [q.limit]
 * @param {number} [q.offset]
 */
export function searchCatalog({
  query,
  year,
  season,
  tag,
  tags = [],
  minScore,
  maxScore,
  maxEps,
  platform,
  inLibrary,
  includeNsfw = false,
  order = 'score',
  limit = 20,
  offset = 0,
} = {}) {
  const where = ['s.type = 2']
  const params = []

  if (query) {
    const like = `%${String(query).trim()}%`
    where.push('(s.title_bgm LIKE ? OR s.title_bgm_origin LIKE ? OR s.aliases LIKE ? OR s.summary LIKE ?)')
    params.push(like, like, like, like)
  }
  if (Number.isFinite(Number(year))) {
    where.push('s.first_air_date LIKE ?')
    params.push(`${Number(year)}%`)
  }
  const months = SEASON_MONTHS[String(season || '').toLowerCase()] || SEASON_MONTHS[String(season || '')]
  if (months) {
    where.push(`CAST(substr(s.first_air_date, 6, 2) AS INTEGER) IN (${months.map(() => '?').join(',')})`)
    params.push(...months)
  }
  const wantTags = [...new Set([tag, ...(Array.isArray(tags) ? tags : [])].filter(Boolean))]
  for (const name of wantTags) {
    where.push('EXISTS (SELECT 1 FROM bgm_tag t WHERE t.bgm_id = s.bgm_id AND t.name = ?)')
    params.push(String(name))
  }
  if (Number.isFinite(Number(minScore))) {
    where.push('s.score >= ?')
    params.push(Number(minScore))
  }
  if (Number.isFinite(Number(maxScore))) {
    where.push('s.score <= ?')
    params.push(Number(maxScore))
  }
  if (Number.isFinite(Number(maxEps))) {
    where.push('s.total_episodes <= ?')
    params.push(Number(maxEps))
  }
  if (platform) {
    const code = Object.entries(PLATFORM_NAMES).find(([, name]) => name === String(platform))?.[0]
    if (code) {
      where.push('s.platform = ?')
      params.push(Number(code))
    }
  }
  if (!includeNsfw) where.push('COALESCE(s.nsfw, 0) = 0')
  if (inLibrary === true) where.push('a.id IS NOT NULL')
  if (inLibrary === false) where.push('a.id IS NULL')

  const orderSql = ORDERS[order] || ORDERS.score
  const cond = where.join(' AND ')
  const rows = db
    .prepare(
      `SELECT s.*, a.id AS lib_id
         FROM bgm_subject s
         LEFT JOIN anime a ON a.bgm_id = s.bgm_id
        WHERE ${cond}
        ORDER BY ${orderSql}
        LIMIT ? OFFSET ?`,
    )
    .all(...params, clamp(limit, 1, 100, 20), clamp(offset, 0, 100000, 0))
  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM bgm_subject s
         LEFT JOIN anime a ON a.bgm_id = s.bgm_id
        WHERE ${cond}`,
    )
    .get(...params).n
  return { rows, total }
}

/** 取单条完整档案（MCP 的 `get_anime` 用） */
export function catalogDetail(bgmId) {
  const row = db
    .prepare(
      `SELECT s.*, a.id AS lib_id, a.title_mikan, a.year AS lib_year, a.season AS lib_season,
              a.weekday, a.poster_src, a.poster_path, a.series_id, a.series_index, a.series_root_title
         FROM bgm_subject s
         LEFT JOIN anime a ON a.bgm_id = s.bgm_id
        WHERE s.bgm_id = ?`,
    )
    .get(String(bgmId))
  if (!row) return null
  const detail = toCatalogRow(row, { withSummary: true })
  detail.library = row.lib_id
    ? {
        id: row.lib_id,
        titleMikan: row.title_mikan,
        year: row.lib_year,
        season: row.lib_season,
        weekday: row.weekday,
        seriesId: row.series_id,
        seriesIndex: row.series_index,
        seriesRootTitle: row.series_root_title,
        posterUrl: row.poster_src || `/api/img/anime/${row.lib_id}`,
      }
    : null
  return detail
}

/**
 * 按标签推荐 —— 给 agent 的「口味」入口
 * ---------------------------------------------------------------------------
 * 打分口径：命中标签数为主（overlap），同分时看评分（score）。
 * 只出 `nsfw = 0`、评分 >= minScore 的；`exclude` 用来排除"已经看过 / 库里已有"的那批。
 */
export function recommendCatalog({ tags = [], exclude = [], minScore = 7, yearFrom, yearTo, maxEps, limit = 12 } = {}) {
  const names = [...new Set((tags || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 12)
  const where = ['s.type = 2', 'COALESCE(s.nsfw, 0) = 0', 's.score >= ?']
  const params = [Number(minScore) || 0]
  if (Number.isFinite(Number(yearFrom))) {
    where.push('s.first_air_date >= ?')
    params.push(`${Number(yearFrom)}-01-01`)
  }
  if (Number.isFinite(Number(yearTo))) {
    where.push('s.first_air_date <= ?')
    params.push(`${Number(yearTo)}-12-31`)
  }
  if (Number.isFinite(Number(maxEps))) {
    where.push('s.total_episodes <= ?')
    params.push(Number(maxEps))
  }
  const excludes = (exclude || []).filter(Boolean).map(String).slice(0, 200)
  if (excludes.length) {
    where.push(`s.bgm_id NOT IN (${excludes.map(() => '?').join(',')})`)
    params.push(...excludes)
  }

  /* 没给标签就没法按口味算 —— 退回「高分榜」，至少是个有用的答案 */
  if (!names.length) {
    const { rows, total } = searchCatalog({ minScore, yearFrom, yearTo, maxEps, order: 'score', limit })
    return { rows: rows.map((r) => ({ ...toCatalogRow(r), matchedTags: [] })), total, tags: [] }
  }

  const rows = db
    .prepare(
      `SELECT s.*, a.id AS lib_id, COUNT(DISTINCT t.name) AS overlap,
              GROUP_CONCAT(DISTINCT t.name) AS matched
         FROM bgm_tag t
         JOIN bgm_subject s ON s.bgm_id = t.bgm_id
         LEFT JOIN anime a ON a.bgm_id = s.bgm_id
        WHERE t.name IN (${names.map(() => '?').join(',')})
          AND ${where.join(' AND ')}
        GROUP BY s.bgm_id
        ORDER BY overlap DESC, s.score DESC
        LIMIT ?`,
    )
    .all(...names, ...params, clamp(limit, 1, 50, 12))
  return {
    rows: rows.map((r) => ({ ...toCatalogRow(r), matchedTags: String(r.matched || '').split(',').filter(Boolean) })),
    total: rows.length,
    tags: names,
  }
}

/** 标签云（推荐时给 agent 参考口径：「你问的标签库里有没有、有多少部」） */
export function tagCloud({ limit = 60, minScore = 7 } = {}) {
  return db
    .prepare(
      `SELECT t.name, COUNT(*) AS n
         FROM bgm_tag t
         JOIN bgm_subject s ON s.bgm_id = t.bgm_id
        WHERE s.score >= ?
        GROUP BY t.name
        ORDER BY n DESC
        LIMIT ?`,
    )
    .all(Number(minScore) || 0, clamp(limit, 1, 300, 60))
}

/** 目录概况（agent 先问「你库里有多少东西」时用） */
export function catalogStats() {
  const one = (sql, ...args) => db.prepare(sql).get(...args)?.n ?? 0
  return {
    anime: one('SELECT COUNT(*) AS n FROM bgm_subject WHERE type = 2'),
    scored: one('SELECT COUNT(*) AS n FROM bgm_subject WHERE type = 2 AND score IS NOT NULL'),
    tags: one('SELECT COUNT(DISTINCT name) AS n FROM bgm_tag'),
    tagRows: one('SELECT COUNT(*) AS n FROM bgm_tag'),
    withStaff: one('SELECT COUNT(*) AS n FROM bgm_subject WHERE type = 2 AND staff IS NOT NULL'),
    withSummary: one('SELECT COUNT(*) AS n FROM bgm_subject WHERE type = 2 AND summary IS NOT NULL'),
    earliest: db.prepare("SELECT MIN(first_air_date) AS d FROM bgm_subject WHERE type = 2 AND first_air_date IS NOT NULL").get()?.d ?? null,
    latest: db.prepare("SELECT MAX(first_air_date) AS d FROM bgm_subject WHERE type = 2 AND first_air_date IS NOT NULL").get()?.d ?? null,
  }
}
