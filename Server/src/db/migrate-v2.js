/**
 * v1 → v2 迁移（一次性、幂等）
 * ---------------------------------------------------------------------------
 * v1 的 `anime` 一张表装了三件事：身份映射、BGM 档案、Mikan 排期。
 * v2 拆成三张：`mikan_bgm_map` / `bgm_subject` / `anime`（只留排期+展示+系列）。
 *
 * 做法（顺序很重要）：
 *   1. `VACUUM INTO` 存一份快照（老库整份可回滚）
 *   2. `anime` 改名 `anime_v1`（这样 schema.sql 才会把新的 `anime` 建出来）
 *   3. schema 建好新表/视图后，从 `anime_v1` 回填映射、档案、排期（**保留原 id**）
 *   4. 删掉 `anime_v1`
 *
 * 为什么保留原 id：qB 老标签、前端正在看的链接都指着它；重建可以，但没必要让它们失效。
 */
import { logger } from '../lib/logger.js'

const hasTable = (db, name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))

const columnsOf = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name))

/** 老结构？`anime` 还有 `score`/`title_cn`（v1 的档案列）就是老结构 */
export function needsV2(db) {
  if (!hasTable(db, 'anime')) return false
  const cols = columnsOf(db, 'anime')
  return cols.has('score') || cols.has('title_cn') || !cols.has('title_mikan')
}

/** 第一步：备份 + 把老表挪开（之后 schema.sql 会建新的 anime） */
export function startV2(db, dbFile) {
  const backup = `${dbFile}.v1-backup.db`
  try {
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)
    logger.warn({ backup }, 'db.migrate v2 backup')
  } catch (err) {
    // 备份失败就别迁：宁可这次不升级，也不能在没有退路时改结构
    logger.error({ err: err.message }, 'db.migrate v2 backup-fail')
    throw err
  }
  db.exec('ALTER TABLE anime RENAME TO anime_v1')
  logger.warn('db.migrate v2 rename anime → anime_v1')
}

/**
 * 第二步（schema 建好新表之后）：从 `anime_v1` 回填三张表，然后删掉老表
 * @returns {{ map:number, subject:number, anime:number }}
 */
export function finishV2(db) {
  if (!hasTable(db, 'anime_v1')) return { map: 0, subject: 0, anime: 0 }
  const cols = columnsOf(db, 'anime_v1')
  const col = (name, fallback = 'NULL') => (cols.has(name) ? name : fallback)
  const now = Date.now()
  const out = { map: 0, subject: 0, anime: 0 }

  db.exec('BEGIN')
  try {
    /* ① 身份映射（mikan_id 唯一；bgm 可能为空） */
    const map = db
      .prepare(
        `INSERT OR IGNORE INTO mikan_bgm_map (mikan_id, bgm_id, title_mikan, checked_at, created_at, updated_at)
         SELECT mikan_id, MAX(bgm_id), MAX(${col('title')}), MAX(${col('bgm_checked_at')}), ?, ?
           FROM anime_v1 WHERE mikan_id IS NOT NULL
          GROUP BY mikan_id`,
      )
      .run(now, now)
    out.map = map.changes

    /* ② BGM 档案（有 bgm_id 就有档案） */
    const subject = db
      .prepare(
        `INSERT OR IGNORE INTO bgm_subject
           (bgm_id, title_bgm, title_bgm_origin, summary, score, rating_total, tags, watching,
            first_air_date, total_episodes, synced_at, source)
         SELECT bgm_id, MAX(${col('title_cn')}), MAX(${col('title')}), MAX(${col('summary')}),
                MAX(${col('score')}), MAX(${col('rating_total')}), MAX(${col('tags')}),
                MAX(${col('watching')}), MAX(${col('air_date')}), MAX(${col('total_episodes')}),
                MAX(${col('bgm_checked_at')}), 'api'
           FROM anime_v1 WHERE bgm_id IS NOT NULL
          GROUP BY bgm_id`,
      )
      .run()
    out.subject = subject.changes

    /* ③ 排期（**保留原 id**；档案列不再复制） */
    const anime = db
      .prepare(
        `INSERT OR IGNORE INTO anime
           (id, mikan_id, bgm_id, title_mikan, poster_path, poster_src, year, season, weekday,
            series_id, series_index, series_relation, naming_style, series_root_title,
            series_checked_at, series_all_movies, bgm_checked_at, updated_at)
         SELECT id, mikan_id, bgm_id, ${col('title')}, ${col('poster_path')}, ${col('poster_src')},
                year, season, weekday, series_id, series_index, series_relation, naming_style,
                series_root_title, series_checked_at, ${col('series_all_movies')},
                bgm_checked_at, updated_at
           FROM anime_v1`,
      )
      .run()
    out.anime = anime.changes

    db.exec('DROP TABLE anime_v1')
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    logger.error({ err: err.message }, 'db.migrate v2 fail')
    throw err
  }

  logger.warn(out, 'db.migrate v2 done')
  return out
}
