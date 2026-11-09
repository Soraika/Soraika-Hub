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

const stmt = {
  upsert: db.prepare(`
    INSERT INTO bgm_subject (bgm_id, title_bgm, title_bgm_origin, summary, score, rating_total,
                             tags, watching, platform, first_air_date, total_episodes, synced_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bgm_id) DO UPDATE SET
      title_bgm        = COALESCE(excluded.title_bgm, bgm_subject.title_bgm),
      title_bgm_origin = COALESCE(excluded.title_bgm_origin, bgm_subject.title_bgm_origin),
      summary          = COALESCE(excluded.summary, bgm_subject.summary),
      score            = COALESCE(excluded.score, bgm_subject.score),
      rating_total     = COALESCE(excluded.rating_total, bgm_subject.rating_total),
      tags             = COALESCE(excluded.tags, bgm_subject.tags),
      watching         = COALESCE(excluded.watching, bgm_subject.watching),
      platform         = COALESCE(excluded.platform, bgm_subject.platform),
      first_air_date   = COALESCE(excluded.first_air_date, bgm_subject.first_air_date),
      total_episodes   = CASE
                           WHEN excluded.total_episodes IS NULL THEN bgm_subject.total_episodes
                           WHEN excluded.total_episodes > COALESCE(bgm_subject.total_episodes, 0)
                             THEN excluded.total_episodes
                           ELSE bgm_subject.total_episodes
                         END,
      synced_at        = COALESCE(excluded.synced_at, bgm_subject.synced_at),
      source           = COALESCE(excluded.source, bgm_subject.source)
  `),
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
export function upsertSubject(patch = {}) {
  if (!patch.bgm_id) return false
  stmt.upsert.run(
    val(patch.bgm_id),
    val(patch.title_bgm),
    val(patch.title_bgm_origin),
    val(patch.summary),
    val(patch.score),
    val(patch.rating_total),
    val(patch.tags),
    val(patch.watching),
    val(patch.platform),
    val(patch.first_air_date),
    val(patch.total_episodes),
    Date.now(),
    val(patch.source || 'api'),
  )
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
