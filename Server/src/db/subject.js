/**
 * Bangumi 档案缓存（`bgm_subject`）—— 评分 / 标签 / 简介 / 放送日 / 集数 / 平台
 * ---------------------------------------------------------------------------
 * 存在的意义：这些字段每周会被离线 dump **整份覆盖**，而 `anime` 是排期+展示的产物。
 * 拆开之后档案能整表清空重灌（4 秒），重建排期也不丢档案。
 *
 * 合并语义与旧 `applyArchiveBatch` 一致：传 null = 这次没拿到，不覆盖已有值；
 * `total_episodes` **只增不减**（周更快照可能落后于上游登记，改小会让「缺哪集」失真）。
 */
import { db, val } from './index.js'

/** 会被写入的所有列（顺序 = INSERT 的列顺序） */
const COLUMNS = [
  'title_bgm', 'title_bgm_origin', 'summary', 'score', 'rating_total', 'tags', 'watching', 'platform',
  'first_air_date', 'total_episodes', 'synced_at', 'source',
  'type', 'bgm_rank', 'nsfw', 'in_series', 'score_details', 'favorite', 'tags_all',
  'staff', 'aliases', 'infobox', 'name_fold',
]

/**
 * 生成 upsert 语句（两种「合并语义」）
 * ---------------------------------------------------------------------------
 * · `fill`    （默认，dump 每周整份覆盖）：**新值优先**，只有这次没拿到的空值才保留旧值。
 *              周更快照就是权威数据，不覆盖等于永远停在第一版。
 * · `missing` （`--only-missing`）：**旧值优先**，只填空。给"我不想覆盖手改过的字段"用。
 *
 * 为什么生成而不是手写两遍：23 个列 × 2 套 COALESCE，手写必然有一列漏掉
 * （漏掉的那列会在某一模式下静默保留旧值 —— 这种 bug 只有对比两套结果才看得见）。
 *
 * `total_episodes` 是唯一的例外：**只增不减**（周更快照可能落后于上游登记，
 * 改小会让「缺哪集」失真），所以两种模式都用同一段 CASE。
 */
function upsertSql(mode) {
  const preferNew = mode !== 'missing'
  const updates = COLUMNS.map((col) => {
    if (col === 'total_episodes') {
      return `      total_episodes   = CASE
                           WHEN excluded.total_episodes IS NULL THEN bgm_subject.total_episodes
                           WHEN excluded.total_episodes > COALESCE(bgm_subject.total_episodes, 0)
                             THEN excluded.total_episodes
                           ELSE bgm_subject.total_episodes
                         END`
    }
    const expr = preferNew
      ? `COALESCE(excluded.${col}, bgm_subject.${col})`
      : `COALESCE(bgm_subject.${col}, excluded.${col})`
    return `      ${col.padEnd(16)} = ${expr}`
  })
  return `
    INSERT INTO bgm_subject (bgm_id, ${COLUMNS.join(', ')})
    VALUES (:bgm_id, ${COLUMNS.map((c) => `:${c}`).join(', ')})
    ON CONFLICT(bgm_id) DO UPDATE SET
${updates.join(',\n')}
  `
}

const stmt = {
  upsert: db.prepare(upsertSql('fill')),
  /** `--only-missing` 用：只填空，不动已有值 */
  upsertMissing: db.prepare(upsertSql('missing')),
  byBgm: db.prepare('SELECT * FROM bgm_subject WHERE bgm_id = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM bgm_subject'),
  countScored: db.prepare('SELECT COUNT(*) AS n FROM bgm_subject WHERE score IS NOT NULL'),
}

/**
 * 写一条档案（`bgm_id` 必填）
 * @param {{ bgm_id: string|number, title_bgm?: string|null, title_bgm_origin?: string|null,
 *           summary?: string|null, score?: number|null, rating_total?: number|null,
 *           tags?: string[]|string|null, watching?: number|null, platform?: number|null,
 *           first_air_date?: string|null, total_episodes?: number|null, source?: string }} patch
 */
export function upsertSubject(patch = {}, { onlyMissing = false } = {}) {
  if (!patch.bgm_id) return false
  const query = onlyMissing ? stmt.upsertMissing : stmt.upsert
  query.run({
    bgm_id: String(patch.bgm_id),
    title_bgm: val(patch.title_bgm),
    title_bgm_origin: val(patch.title_bgm_origin),
    summary: val(patch.summary),
    score: val(patch.score),
    rating_total: val(patch.rating_total),
    tags: val(patch.tags),
    watching: val(patch.watching),
    platform: val(patch.platform),
    first_air_date: val(patch.first_air_date),
    total_episodes: val(patch.total_episodes),
    synced_at: Date.now(),
    source: val(patch.source || 'api'),
    type: val(patch.type),
    bgm_rank: val(patch.bgm_rank),
    nsfw: val(patch.nsfw),
    in_series: val(patch.in_series),
    score_details: val(patch.score_details),
    favorite: val(patch.favorite),
    tags_all: val(patch.tags_all),
    staff: val(patch.staff),
    aliases: val(patch.aliases),
    infobox: val(patch.infobox),
    name_fold: val(patch.name_fold),
  })
  return true
}

/**
 * 一批档案写库（一个事务）
 * @param {Array<{ bgm_id: string|number }>} rows
 */
export function upsertSubjects(rows = []) {
  if (!rows.length) return 0
  db.exec('BEGIN')
  try {
    for (const row of rows) upsertSubject(row)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return rows.length
}

export const getSubject = (bgmId) => stmt.byBgm.get(val(bgmId)) ?? null
export const countSubjects = () => stmt.count.get()?.n ?? 0
export const countScoredSubjects = () => stmt.countScored.get()?.n ?? 0

/* ── 全站动画库（dump 里 type=2 全量落库之后的读写）──────────────────────── */

const stmtFull = {
  insertTag: db.prepare(
    `INSERT INTO bgm_tag (bgm_id, name, count) VALUES (?, ?, ?)
     ON CONFLICT(bgm_id, name) DO UPDATE SET count = MAX(COALESCE(excluded.count, 0), COALESCE(bgm_tag.count, 0))`,
  ),
  clearTags: db.prepare('DELETE FROM bgm_tag'),
  countAnime: db.prepare('SELECT COUNT(*) AS n FROM bgm_subject WHERE type = 2'),
  countAll: db.prepare('SELECT COUNT(*) AS n FROM bgm_subject'),
  countTags: db.prepare('SELECT COUNT(*) AS n FROM bgm_tag'),
  byFold: db.prepare('SELECT bgm_id, title_bgm, title_bgm_origin, first_air_date FROM bgm_subject WHERE name_fold = ? LIMIT 5'),
  distinctTag: db.prepare('SELECT COUNT(DISTINCT name) AS n FROM bgm_tag'),
  /** 「档案已齐全」的 id 列表（only-missing 模式据此跳过整行） */
  completeIds: db.prepare(
    `SELECT bgm_id FROM bgm_subject
      WHERE type = 2 AND score IS NOT NULL AND tags IS NOT NULL AND summary IS NOT NULL`,
  ),
  /** 话数回填：只增不减（周更快照可能落后于上游登记） */
  setEpisodes: db.prepare(
    'UPDATE bgm_subject SET total_episodes = ? WHERE bgm_id = ? AND (total_episodes IS NULL OR total_episodes < ?)',
  ),
}

/**
 * 一批**完整**档案写库（一个事务；标签倒排一起写）
 * @param {Array<object>} rows `domain/bgm-archive.js#fullSubjectRow` 的输出
 * @param {Array<object>} [tagRows] `tagRowsOf()` 的输出（同一个事务里写，省一半事务开销）
 */
export function upsertFullSubjects(rows = [], tagRows = [], { onlyMissing = false } = {}) {
  if (!rows.length) return 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows) upsertSubject(row, { onlyMissing })
    for (const tag of tagRows) stmtFull.insertTag.run(String(tag.bgm_id), tag.name, tag.count ?? null)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return rows.length
}

/** 整表重灌前清标签倒排（与关系表同节奏：每周一次） */
export function clearTags() {
  stmtFull.clearTags.run()
}

export const countFullAnime = () => stmtFull.countAnime.get()?.n ?? 0
export const countArchiveRows = () => stmtFull.countAll.get()?.n ?? 0
export const countTagRows = () => stmtFull.countTags.get()?.n ?? 0
export const countDistinctTags = () => stmtFull.distinctTag.get()?.n ?? 0

/** 归一化名字查（比 `bgm_stub` 那份索引多带了原名与放送日，下载页认作品用得上） */
export const subjectsByFold = (fold) => stmtFull.byFold.all(String(fold || ''))

/**
 * 批量回填话数（`Map<mikanId|bgmId, 集数>`，键是 BGM 条目 id）
 * 一个事务：3 万条单条 UPDATE 各自开事务要几十秒
 * @param {Map<number|string, number>} counts
 */
export function setCatalogEpisodes(counts) {
  if (!counts?.size) return 0
  let changed = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [id, n] of counts) {
      const total = Number(n)
      if (!Number.isFinite(total) || total <= 0) continue
      changed += Number(stmtFull.setEpisodes.run(total, String(id), total).changes || 0)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return changed
}

/**
 * 档案齐全的动画 id 集合（`--only-missing` 用）
 * ---------------------------------------------------------------------------
 * 全量入库之后，「只补空字段」的语义要落到档案表上：
 * 已经有评分 + 标签 + 简介的条目**整行不动**（连标签倒排也不重写），
 * 否则每周一次的 dump 会把人工修过/上游更新的字段整片刷掉。
 */
export function catalogCompleteIds() {
  return new Set(stmtFull.completeIds.all().map((row) => String(row.bgm_id)))
}
