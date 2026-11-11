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
import { rememberMikan } from './map.js'

/** 排期表的列（顺序与 insert 占位符一一对应）；**档案列已搬到 `bgm_subject`** */
const COLUMNS = ['mikan_id', 'bgm_id', 'title_mikan', 'poster_path', 'poster_src', 'year', 'season', 'weekday']

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
INSERT INTO anime (${COLUMNS.join(', ')}, updated_at)
VALUES (${placeholders}, ?)
ON CONFLICT(mikan_id) DO UPDATE SET
    ${updateAssignments},
    bgm_id = COALESCE(excluded.bgm_id, anime.bgm_id),
    updated_at = excluded.updated_at
`

/** Bangumi 侧补齐：以 bgm_id 为冲突键（只有 bgm 的条目也能先落库） */
const upsertByBgmSql = `
INSERT INTO anime (${COLUMNS.join(', ')}, updated_at)
VALUES (${placeholders}, ?)
ON CONFLICT(bgm_id) DO UPDATE SET
    ${updateAssignments},
    mikan_id = COALESCE(excluded.mikan_id, anime.mikan_id),
    updated_at = excluded.updated_at
`

const stmt = {
  upsertByMikan: db.prepare(upsertByMikanSql),
  upsertByBgm: db.prepare(upsertByBgmSql),
  byId: db.prepare('SELECT * FROM v_anime WHERE id = ?'),
  byMikanId: db.prepare('SELECT * FROM v_anime WHERE mikan_id = ?'),
  byBgmId: db.prepare('SELECT * FROM v_anime WHERE bgm_id = ?'),
  /**
   * 按番名找（下载页用：老种子的标签丢了，只能靠归档目录名认回来）
   * 只认**完全相等**的中文名/原名 —— 模糊匹配会把「碧蓝之海」和「碧蓝之海 第二季」认错，
   * 那种错认比「认不出、归到未识别」更糟（会把两部的集数混在一起）
   */
  byTitle: db.prepare('SELECT * FROM v_anime WHERE title_bgm = ? OR title_mikan = ? OR title_bgm_origin = ? LIMIT 1'),

  bySeason: db.prepare(`
    SELECT * FROM v_anime
    WHERE year = ? AND season = ?
    ORDER BY weekday ASC, score IS NULL, score DESC, id ASC
  `),
  maxUpdatedAt: db.prepare('SELECT MAX(updated_at) AS t FROM anime WHERE year = ? AND season = ?'),
  countAll: db.prepare('SELECT COUNT(*) AS n FROM anime'),
  /**
   * 只绑定身份/海报，不动排期归属（year/season/weekday 永远由 Mikan 决定）。
   * 档案（评分/标签/…）现在写 `bgm_subject`，不在这里。
   */
  updateMeta: db.prepare(`
    UPDATE anime SET
      bgm_id       = COALESCE(?, bgm_id),
      -- 海报源换了就清掉本地缓存路径，让出图接口下次重新抓（否则会一直发旧图）
      poster_path  = CASE WHEN ? IS NOT NULL AND ? IS NOT poster_src THEN NULL ELSE poster_path END,
      poster_src   = COALESCE(?, poster_src),
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
      -- 有 bgm_id 但档案还空着的（评分/标签/简介任一为空）→ 档案补齐队列的目标
      SUM(CASE WHEN bgm_id IS NOT NULL AND (score IS NULL OR tags IS NULL OR summary IS NULL)
               THEN 1 ELSE 0 END)                                              AS needArchive
    FROM v_anime
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
      stmt.upsertByMikan.run(...COLUMNS.map((c) => val(row[c])), now)
      // 顺手把「mikan ↔ bgm」登记进身份表：**重建 anime 时它是唯一留下的东西**。
      // 排期页只有 mikan_id（bgm 还没解析），所以 bgm_id 传 null，等补齐队列去确认。
      rememberMikan(row.mikan_id, row.title_mikan)
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
  const normalized = { ...row, title_mikan: row.title_mikan ?? row.title }
  const existing =
    (row.mikan_id && stmt.byMikanId.get(val(row.mikan_id))) ||
    (row.bgm_id && stmt.byBgmId.get(val(row.bgm_id))) ||
    null

  if (!existing) {
    if (!normalized.title_mikan) throw new Error('applyBgmMeta：新建记录必须带 title')
    const now = Date.now()
    stmt.upsertByBgm.run(...COLUMNS.map((c) => val(normalized[c])), now)
    if (row.mikan_id) rememberMikan(row.mikan_id, normalized.title_mikan, row.bgm_id)
    return { id: stmt.byBgmId.get(val(row.bgm_id))?.id ?? null, created: true }
  }

  stmt.updateMeta.run(
    val(row.bgm_id),
    val(row.poster_src), // CASE：新海报地址非空 …
    val(row.poster_src), // CASE：… 且与原地址不同 → 清掉本地缓存
    val(row.poster_src), // poster_src 本体
    Date.now(),
    existing.id,
  )
  // 身份确认成功 → 记进映射表（重建 anime 也不会丢）
  if (row.mikan_id) rememberMikan(row.mikan_id, normalized.title_mikan, row.bgm_id)
  return { id: existing.id, created: false }
}

/**
 * 离线 dump（bangumi/Archive）批量刷新档案 —— 与 `applyBgmMeta` 的区别只在「一次来一批」
 * ---------------------------------------------------------------------------
 * 为什么单独一组 SQL、不复用 updateMeta：那个是「逐条补齐 + 可能新建行」，走的是
 * mikan_id / bgm_id 双键判断、还带海报缓存清理。离线导入是**只更新已有行的档案字段**，
 * 几千行一条一条来太慢，所以这里是一条纯 UPDATE、外面包一层事务。
 *
 * 语义：`COALESCE(?, col)` = 传 null 的字段不动（dump 没有的值不覆盖库里已有的），
 * 与全库的合并规则一致（ARCHITECTURE §2.1）。
 * `bgm_checked_at` 写成导入时间：档案刚刷新过，档案补齐队列就别再为这些行打上游了
 * （当年番的每日更新不看它，仍然照常走 API）。
 */
const archiveStmt = {
  /** 待补的行：只认已有 bgm_id 的（档案字段现在从 `v_anime` 取，即 bgm_subject） */
  targets: db.prepare('SELECT id, bgm_id, score, tags, summary FROM v_anime WHERE bgm_id IS NOT NULL'),
  /**
   * 档案本体已搬到 `bgm_subject`（导入侧单独写）；这里只记「刷过了」——
   * 档案队列/每日更新的退避窗口还是看 anime 上的 `bgm_checked_at`（簿记，不是档案）。
   */
  touch: db.prepare('UPDATE anime SET bgm_checked_at = COALESCE(?, bgm_checked_at), updated_at = ? WHERE id = ?'),
}

/** 库里所有「有 bgm_id」的行（离线 dump 导入的目标集合） */
export const listBgmTargets = () => archiveStmt.targets.all()

/**
 * 一批导入完成后的「簿记」写库（一个事务）
 * @param {Array<{ id:number }>} rows
 * @param {{ checkedAt?: number|null }} [options] `checkedAt` 为 null 表示不改 `bgm_checked_at`
 * @returns {number} 写入行数
 */
export function applyArchiveBatch(rows = [], { checkedAt = Date.now() } = {}) {
  if (!rows.length) return 0
  const now = Date.now()
  db.exec('BEGIN')
  try {
    for (const row of rows) archiveStmt.touch.run(val(checkedAt), now, val(row.id))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return rows.length
}

/** 取某季全部条目（按星期、评分排序） */
export const listBySeason = (year, season) => stmt.bySeason.all(val(year), val(season))

/** 该季最近一次写入时间（缓存新鲜度判定） */
export const maxUpdatedAt = (year, season) => stmt.maxUpdatedAt.get(val(year), val(season))?.t ?? 0

/** 全库条目数（排错/统计用） */
export const countAll = () => stmt.countAll.get().n

/**
 * 关键词归一化：全角 ASCII → 半角、全角空格 → 空格、压空白、转小写
 * ---------------------------------------------------------------------------
 * 中文输入法很容易带全角括号 / 空格（`ＥＶＡ（２０２４）`），而库里的标题是半角；
 * 不做归一化的话「看着一样却搜不到」。
 */
export function normalizeKeyword(text) {
  return String(text || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000\u00a0]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** 把一句话切成检索词（空格 / 中英文标点都算分隔），最多 5 个 —— 再多基本是「搜不到」而不是「搜得准」 */
export function splitTerms(keyword) {
  const text = normalizeKeyword(keyword)
  if (!text) return []
  const parts = text
    .split(/[\s,，、/|·・:：;；!?！？()（）[\]【】"'“”‘’_-]+/)
    .map((term) => term.replace(/[%_\\]/g, '')) // LIKE 通配符没意义，去掉免得变成「全表命中」
    .filter(Boolean)
  return [...new Set(parts)].slice(0, 5)
}

/**
 * 相关度打分（越高越靠前）
 * 完全同名 > 前缀命中 > 包含 > 只是分词命中；分词命中的位置越靠前分越高。
 */
function scoreOf(row, text, terms) {
  const titles = [row.title_bgm, row.title_mikan, row.title_bgm_origin].map(normalizeKeyword).filter(Boolean)
  let best = 0
  for (const title of titles) {
    if (title === text) best = Math.max(best, 100)
    else if (title.startsWith(text)) best = Math.max(best, 70)
    else if (title.includes(text)) best = Math.max(best, 50)
    for (const term of terms) {
      const at = title.indexOf(term)
      if (at >= 0) best = Math.max(best, 20 + Math.max(0, 8 - at))
    }
  }
  return best
}

/**
 * 编辑距离（Levenshtein），超过上限立刻放弃
 * ---------------------------------------------------------------------------
 * 只为一件事：**用户记错/打错一个字**也能搜到（「上伊娜」「上依娜」→「上伊那」）。
 * 提前退出很关键：几千条标题逐个比也不会慢（大部分在前几行就超限）。
 */
export function editDistance(a, b, limit = 2) {
  const s = String(a || '')
  const t = String(b || '')
  if (s === t) return 0
  if (Math.abs(s.length - t.length) > limit) return limit + 1
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i)
  for (let i = 1; i <= s.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > limit) return limit + 1
    prev = cur
  }
  return prev[t.length]
}

/**
 * 错字兜底：整句搜不到时，按「长度相近的窗口」算编辑距离
 * ---------------------------------------------------------------------------
 * 只在精确/分词搜索 **0 结果**时跑，所以正常搜索一点不慢。
 * 窗口比较是为了「记忆里只有名字的一部分」：`上伊娜` 对 `上伊那牡丹，酒醉…` 整体算距离很大，
 * 但对前 3 个字的窗口只差 1。
 */
function typoSearch(text, limit = 30) {
  const query = text.replace(/\s+/g, '')
  if (query.length < 2) return []
  // 短词只容 1 个错（3 个字容 2 个错就什么都像了），长词容 2 个
  const maxDistance = query.length >= 5 ? 2 : 1
  const rows = db.prepare('SELECT * FROM v_anime').all()
  const hits = []
  for (const row of rows) {
    const titles = [row.title_bgm, row.title_mikan, row.title_bgm_origin].map(normalizeKeyword).filter(Boolean)
    let best = maxDistance + 1
    for (const title of titles) {
      const flat = title.replace(/\s+/g, '')
      best = Math.min(best, editDistance(query, flat, maxDistance))
      if (best === 0) break
      // 标题比查询长：只比长度相近的窗口
      for (let i = 0; i + query.length <= flat.length && best > 0; i++) {
        best = Math.min(best, editDistance(query, flat.slice(i, i + query.length), maxDistance))
      }
      if (best === 0) break
    }
    if (best <= maxDistance) hits.push({ row, distance: best })
  }
  return hits
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        (Number(b.row.score) || -1) - (Number(a.row.score) || -1) ||
        Number(b.row.id) - Number(a.row.id),
    )
    .slice(0, Number(limit) || 30)
    .map((hit) => hit.row)
}

/**
 * AI 搜索的候选池（**AI 只能从这里面挑**，防止它编造不存在的番）
 * ---------------------------------------------------------------------------
 * 打分：分词命中（重要）+ 单字重合（容忍错字/只记得大概）；
 * 一个都没命中（典型：「推荐几部百合」）时补一组高评分番，否则 AI 手里没有可挑的东西。
 * 只给 AI 需要的最小字段（id / 标题 / 年季 / 评分），不带简介 —— 省 token。
 * @param {string} keyword
 * @param {number} [limit]
 */
export function searchCandidates(keyword, limit = 40) {
  const text = normalizeKeyword(keyword)
  if (!text) return []
  const terms = splitTerms(keyword)
  const chars = [...new Set(text.replace(/\s+/g, ''))].filter((ch) => /[\u3400-\u9fff\u3040-\u30ffa-z0-9]/i.test(ch))
  const picked = []
  const seen = new Set()

  /* 先放「普通搜索（含分词 / 编辑距离兜底）已经认出来的」—— 打错一个字的情况直接排最前 */
  for (const row of searchByKeyword(keyword, Math.min(12, limit))) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    picked.push({ row, score: 0 })
  }

  const rows = db.prepare('SELECT * FROM v_anime').all()
  const queryFlat = text.replace(/\s+/g, '')
  const scored = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    const title = normalizeKeyword(row.title_bgm || row.title_mikan || row.title_bgm_origin || '')
    if (!title) continue
    let termHit = 0
    for (const term of terms) if (title.includes(term)) termHit++
    let charHit = 0
    for (const ch of chars) if (title.includes(ch)) charHit++
    // 开头重合的字权更高：「上伊那牡丹」与「上依娜」开头就对上，比标题里恰巧有个「娜」的更相关
    let prefix = 0
    while (prefix < queryFlat.length && prefix < title.length && queryFlat[prefix] === title[prefix]) prefix++
    const score = termHit * 10 + charHit + prefix * 2
    if (score > 0) scored.push({ row, score })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (Number(b.row.score) || -1) - (Number(a.row.score) || -1) ||
      Number(b.row.id) - Number(a.row.id),
  )
  for (const item of scored) {
    if (picked.length >= limit) break
    if (seen.has(item.row.id)) continue
    seen.add(item.row.id)
    picked.push(item)
  }

  /* 还是太少（典型：「推荐几部百合」）→ 补一组高评分番，否则 AI 手里没有可挑的东西 */
  if (picked.length < 10) {
    const top = db
      .prepare(
        `SELECT * FROM v_anime WHERE score IS NOT NULL
          ORDER BY score DESC, updated_at DESC LIMIT ?`,
      )
      .all(Math.max(10, limit - picked.length))
    for (const row of top) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      picked.push({ row, score: 0 })
    }
  }
  return picked.slice(0, limit).map(({ row }) => ({
    id: row.id,
    title: row.title_bgm || row.title_mikan || row.title_bgm_origin || '',
    year: row.year ?? null,
    season: row.season || '',
    score: row.score ?? null,
    tags: parseJsonTags(row.tags),
  }))
}

/** `tags` 列是 JSON 数组字符串 → 数组（坏数据当空） */
function parseJsonTags(value) {
  try {
    const list = JSON.parse(String(value || '[]'))
    return Array.isArray(list) ? list.slice(0, 4).map(String) : []
  } catch {
    return []
  }
}

/**
 * 按筛选条件列一批（AI 搜索在「关键词搜不到但用户给了年/季/评分/题材」时用它兜底）
 * @param {{ year?: number|null, season?: string|null, weekday?: number|null, minScore?: number|null, tags?: string[] }} filters
 */
export function listByFilters(filters = {}, limit = 60) {
  const where = []
  const params = []
  if (filters.year) {
    where.push('year = ?')
    params.push(Number(filters.year))
  }
  if (filters.season) {
    where.push('season = ?')
    params.push(String(filters.season))
  }
  if (filters.weekday != null) {
    where.push('weekday = ?')
    params.push(Number(filters.weekday))
  }
  if (filters.minScore != null) {
    where.push('score >= ?')
    params.push(Number(filters.minScore))
  }
  for (const tag of (filters.tags || []).slice(0, 3)) {
    where.push('tags LIKE ?')
    params.push(`%${tag}%`)
  }
  const sql = `SELECT * FROM v_anime ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY score IS NULL, score DESC, updated_at DESC LIMIT ?`
  return db.prepare(sql).all(...params, Number(limit) || 60)
}

/**
 * 按关键词搜作品（搜索页用）
 * ---------------------------------------------------------------------------
 * 支持「模糊」的四层：
 *   · 空格分词：`进击 巨人` / `巨人 进击` 都能命中（词序无关，AND 连接）；
 *   · 归一化：全角/大小写/多余空白都不影响（`ＥＶＡ` = `eva`）；
 *   · 相关度排序：完全同名 > 前缀 > 包含 > 分词命中，再按评分兜底；
 *   · 整句 0 结果时按编辑距离兜底（打错一个字、只记得大概）。
 * 数据量是几千行，LIKE 足够快（不引 FTS5：中文分词反而更差，还多一张要同步的表）。
 * 上限 30：搜索是给人挑的，不是导出；取 200 条候选再排序，够用且稳定。
 */
export function searchByKeyword(keyword, limit = 30, { fuzzy = true } = {}) {
  const text = normalizeKeyword(keyword)
  const terms = splitTerms(keyword)
  if (!text || !terms.length) return []

  const where = terms.map(() => '(title_bgm LIKE ? OR title_mikan LIKE ? OR title_bgm_origin LIKE ?)').join(' AND ')
  const params = terms.flatMap((term) => {
    const like = `%${term}%`
    return [like, like, like]
  })
  const rows = db.prepare(`SELECT * FROM v_anime WHERE ${where} LIMIT 200`).all(...params)

  const ranked = rows
    .map((row) => ({ row, score: scoreOf(row, text, terms) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (Number(b.row.score) || -1) - (Number(a.row.score) || -1) ||
        Number(b.row.id) - Number(a.row.id),
    )
    .slice(0, Number(limit) || 30)
    .map((hit) => hit.row)

  return ranked.length || !fuzzy ? ranked : typoSearch(text, limit)
}

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
      series_checked_at = COALESCE(?, series_checked_at),
      series_named_at   = COALESCE(?, series_named_at),
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
    INSERT INTO anime (bgm_id, title_mikan, series_checked_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(bgm_id) DO NOTHING
  `),
}

/**
 * 写一部作品的系列信息（只传要更新的字段；传 null 不覆盖已有值）
 * @param {number} id 作品主键
 * @param {{ seriesId?:number, seriesIndex?:number|null, seriesRelation?:string,
 *           namingStyle?:string, seriesRootTitle?:string,
 *           seriesCheckedAt?:number, seriesNamedAt?:number }} [meta]
 */
export function setSeriesMeta(id, meta = {}) {
  const now = Date.now()
  return seriesStmt.updateMeta.run(
    val(meta.seriesId),
    val(meta.seriesIndex),
    val(meta.seriesRelation),
    val(meta.namingStyle),
    val(meta.seriesRootTitle),
    val(meta.seriesCheckedAt ?? now),
    val(meta.seriesNamedAt ?? now),
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
 * 这条作品所在的系列是不是「整条都是剧场版」
 * ---------------------------------------------------------------------------
 * 判据看 `bgm_subject.platform === 3`（dump 的剧场版平台码，确定性、不问 AI）。
 * platform 拿不到（API 路径 / 老数据）时返回 null —— 宁可不动，也不误判。
 * 用途：档案补齐刚写进 air_date 时触发一次重排（剧场版系列按上映日期排）。
 * @returns {number|null} 是的话返回 series_id，否则 null
 */
export function isMovieOnlySeries(rowId) {
  const row = db.prepare('SELECT series_id FROM anime WHERE id = ?').get(val(rowId))
  if (!row?.series_id) return null
  const stat = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN platform = 3 THEN 1 ELSE 0 END) AS movies
         FROM v_anime WHERE series_id = ?`,
    )
    .get(val(row.series_id))
  return stat?.n > 0 && Number(stat.movies) === Number(stat.n) ? row.series_id : null
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
  // 骨架行没有 Mikan 标题，用 Bangumi 中文名（退原名）占位；展示时 title_bgm 会优先
  const name = String(titleCn ?? title ?? '').trim() || `BGM ${id}`
  seriesStmt.insertStub.run(val(id), val(name), val(seriesCheckedAt ?? now), now)
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
    .prepare(`SELECT id, bgm_id, title_mikan, title_bgm, title_bgm_origin, series_id, series_index,
                     series_relation, naming_style, series_root_title,
                     air_date, year, season, platform, total_episodes
                FROM v_anime WHERE bgm_id IN (${placeholders})`)
    .all(...ids.map((v) => val(v)))
}
