/**
 * SQLite 连接 —— 用 Node 内置的 node:sqlite（零依赖，不用编译原生模块）
 * ---------------------------------------------------------------------------
 * 为什么不用 better-sqlite3：它要从 GitHub 拉预编译二进制，网络受限的机器会卡住；
 * node:sqlite 是 Node 22.5+ 自带的。首次连接时自动建 data/ 目录并执行 schema.sql。
 * 换库（sqlite-vec / pgvector）时只改 db/ 这一层，上层 api/ 不动。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

const dbPath = resolve(process.cwd(), config.dbFile)
mkdirSync(dirname(dbPath), { recursive: true })

export const db = new DatabaseSync(dbPath)

// WAL：读写不互相阻塞（爬虫在写、接口在读时很有用）
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
// 多进程写（API + 独立 worker + 一次性任务）时别立刻报 SQLITE_BUSY，等一下锁
db.exec('PRAGMA busy_timeout = 5000')

/**
 * 删掉废弃的字幕组**关系**表（一次性、可重入）
 * ---------------------------------------------------------------------------
 * `anime_subgroup`（作品 ↔ 字幕组 + **该作品下的 RSS id**）已废弃：那个映射每次都能现取
 * —— Mikan 详情页一页就带着「字幕组 + 各自的 RSS id」，前端拿到 id 后取资源时回传即可。
 * 同时兼容更老的结构（`subgroup` 表自己带 `anime_id`、同一组按作品重复存）→ 一并重建。
 * `subgroup` **字典**保留：它只有 id → 名字，随面板打开自动重建（丢了也不影响功能）。
 */
function dropLegacySubgroupLinks() {
  const has = (name) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)

  if (has('anime_subgroup')) {
    const links = db.prepare('SELECT COUNT(*) AS n FROM anime_subgroup').get().n
    db.exec('DROP TABLE IF EXISTS anime_subgroup')
    logger.warn({ links }, 'db.migrate drop anime_subgroup')
  }

  if (has('subgroup')) {
    const cols = new Set(db.prepare('PRAGMA table_info(subgroup)').all().map((c) => c.name))
    if (cols.has('anime_id')) {
      const rows = db.prepare('SELECT COUNT(*) AS n FROM subgroup').get().n
      db.exec('DROP TABLE IF EXISTS subgroup') // 老结构：重建为纯字典（schema.sql 会建回来）
      logger.warn({ rows }, 'db.migrate rebuild subgroup dict')
    }
  }
}

dropLegacySubgroupLinks()

/**
 * 系列季位的**唯一性护栏**（一次性、可重入）
 * ---------------------------------------------------------------------------
 * 为什么需要：同一系列可能被**两条不同的链**写（BGM 的关系是局部的：《我的英雄学院》
 * 剧场版之间互连、TV 之间互连），而且两个进程（API 内联 worker + 独立回填 CLI）可能
 * 同时给同一系列算季位 —— 都从 NULL 起步时各写各的编号，结果出现「两个 index=1」。
 *
 * 做法：先按 `(series_id, series_index)` 去重（同组保留 id 最小的那条，其余置 NULL），
 * 再建**部分唯一索引** —— 之后重复写入会直接报约束错误（被 fillSeriesFor 的 try 兜住，
 * 只会让那条重试，不会污染数据）。
 */
function ensureSeriesPositionUnique() {
  const dupes = db
    .prepare(
      `SELECT series_id, series_index, COUNT(*) c FROM anime
        WHERE series_id IS NOT NULL AND series_index IS NOT NULL
        GROUP BY series_id, series_index HAVING c > 1`,
    )
    .all()
  if (dupes.length) {
    const fix = db.prepare(
      `UPDATE anime SET series_index = NULL
        WHERE series_id = ? AND series_index = ? AND id <> (
          SELECT MIN(id) FROM anime WHERE series_id = ? AND series_index = ?
        )`,
    )
    db.exec('BEGIN')
    try {
      let cleared = 0
      for (const d of dupes) {
        cleared += fix.run(d.series_id, d.series_index, d.series_id, d.series_index).changes
      }
      db.exec('COMMIT')
      logger.warn({ groups: dupes.length, cleared }, 'db.migrate dedupe series_index')
    } catch (err) {
      db.exec('ROLLBACK')
      logger.error({ err: err.message }, 'db.migrate dedupe fail')
    }
  }
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_anime_series_pos
         ON anime(series_id, series_index) WHERE series_index IS NOT NULL`,
    )
  } catch (err) {
    logger.warn({ err: err.message }, 'db.migrate series pos index fail')
  }
}

/**
 * 轻量迁移 —— 给**已存在**的库补新列（**必须在建表之前跑**，见下方注释）
 * ---------------------------------------------------------------------------
 * schema.sql 里写的是 CREATE TABLE IF NOT EXISTS：表已存在时那句会被跳过，
 * 新加的列不会自动出现（SQLite 也不支持 ADD COLUMN IF NOT EXISTS）。
 * 所以这里按 PRAGMA table_info 对账，缺哪个补哪个 —— 只追加、不修改、不重建，
 * 已有数据（我们库里已经攒了几百条）不会丢。
 * 约定：以后每次给 anime 表加列，① 改 schema.sql ② 在 MIGRATIONS 里加一条。
 * （加了列还要建索引也直接写进 schema.sql 就行 —— 补列发生在它之前。）
 */
const MIGRATIONS = {
  anime: [
    { column: 'watching', ddl: 'INTEGER' },
    { column: 'bgm_checked_at', ddl: 'INTEGER' },
    { column: 'bgm_miss_count', ddl: 'INTEGER' },
    // 系列链（见 CONVENTIONS.md §10.2：只给「已在库」的作品写；series_id 取代表行的 id）
    { column: 'series_id', ddl: 'INTEGER' },
    { column: 'series_index', ddl: 'INTEGER' },
    { column: 'series_relation', ddl: 'TEXT' },
    { column: 'naming_style', ddl: 'TEXT' },
    { column: 'series_root_title', ddl: 'TEXT' },
    { column: 'series_checked_at', ddl: 'INTEGER' },
    // 「整条系列都是剧场版」的判定结果（AI 给的 allMovies）—— 存下来，
    // 否则后续走链因为「根名已有」跳过 AI，会把这个判据丢掉 → 番外又被清零。
    { column: 'series_all_movies', ddl: 'INTEGER' },
  ],
}

function ensureColumns() {
  for (const [table, columns] of Object.entries(MIGRATIONS)) {
    // 表还不存在（全新库）→ 跳过：schema.sql 会带着全部列把表建出来
    const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
    if (!exists) continue
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((col) => col.name))
    for (const { column, ddl } of columns) {
      if (existing.has(column)) continue
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
      logger.info({ table, column, ddl }, 'db.migrate add-column')
    }
  }
}

ensureColumns()

/**
 * 建表（schema.sql 全是 IF NOT EXISTS，重复执行安全）
 * ---------------------------------------------------------------------------
 * **必须放在补列之后**：schema.sql 里除了建表还有「给新列建索引」
 * （如 `CREATE INDEX idx_anime_series ON anime(series_id)`），老库的 anime 表还没这一列时
 * `CREATE TABLE IF NOT EXISTS` 会被跳过、索引却照建 → 直接报 `no such column`。
 * 顺序：dropLegacySubgroupLinks → 补列 → schema.sql ✅
 * 季位唯一索引也放在最后（`ensureSeriesPositionUnique`）：全新库里 anime 还没建出来时
 * 进去建索引会直接报 `no such table: anime`（verify-settings 用临时库启动就踩到了）。
 */
const schemaSql = readFileSync(resolve(import.meta.dirname, 'schema.sql'), 'utf8')
db.exec(schemaSql)

/**
 * 一次性回填「身份映射」`mikan_bgm_map`（幂等）
 * ---------------------------------------------------------------------------
 * 老库里映射是塞在 `anime` 里的（`mikan_id` + `bgm_id`）。拆表后必须补一份，
 * 否则档案补齐队列会以为"全都没映射过"，把几千条重扫一遍。
 * `INSERT OR IGNORE` + 主键/唯一索引保证重复启动不会出错。
 */
function backfillMikanMap() {
  const hasAnime = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'anime'").get()
  if (!hasAnime) return
  const cols = new Set(db.prepare('PRAGMA table_info(anime)').all().map((col) => col.name))
  if (!cols.has('mikan_id') || !cols.has('bgm_id')) return
  const now = Date.now()
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO mikan_bgm_map (mikan_id, bgm_id, title_mikan, checked_at, created_at, updated_at)
       SELECT mikan_id, MAX(bgm_id), MAX(title), MAX(bgm_checked_at), ?, ?
         FROM anime WHERE mikan_id IS NOT NULL
        GROUP BY mikan_id`,
    )
    .run(now, now)
  if (res.changes) logger.info({ rows: res.changes }, 'db.migrate backfill mikan_bgm_map')
}

backfillMikanMap()

/**
 * 一次性回填「BGM 档案」`bgm_subject`（幂等）
 * ---------------------------------------------------------------------------
 * 老库里档案字段在 `anime` 上；拆表后先补一份，之后 `npm run dump` 直接覆盖它。
 * `INSERT OR IGNORE`：已经有了就别动（避免把 dump 灌进去的新值又用旧值盖回来）。
 */
function backfillSubjects() {
  const hasAnime = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'anime'").get()
  if (!hasAnime) return
  const cols = new Set(db.prepare('PRAGMA table_info(anime)').all().map((col) => col.name))
  if (!cols.has('score') || !cols.has('title_cn')) return
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO bgm_subject
         (bgm_id, title_bgm, title_bgm_origin, summary, score, rating_total, tags, watching,
          first_air_date, total_episodes, synced_at, source)
       SELECT bgm_id, MAX(title_cn), MAX(title), MAX(summary), MAX(score), MAX(rating_total),
              MAX(tags), MAX(watching), MAX(air_date), MAX(total_episodes), MAX(bgm_checked_at), 'api'
         FROM anime WHERE bgm_id IS NOT NULL
        GROUP BY bgm_id`,
    )
    .run()
  if (res.changes) logger.info({ rows: res.changes }, 'db.migrate backfill bgm_subject')
}

backfillSubjects()

ensureSeriesPositionUnique()

export const dbFile = dbPath

/**
 * 写库参数规范化 —— node:sqlite 只接受 null / number / string / bigint / Uint8Array
 * ---------------------------------------------------------------------------
 * undefined / 空串 / 空数组一律转 null：配合 upsert 里的 COALESCE，
 * 「这次没拿到的字段」就不会把库里已有的值覆盖成空（首次落 Mikan 排期时 score 还是空的，
 * 后来补齐的评分不能被下一次排期刷新抹掉）。
 * 放在连接模块里，供 anime（表 CRUD）与 queue（队列标记）共用。
 */
export const val = (v) => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (Array.isArray(v)) return v.length ? JSON.stringify(v) : null
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v)
  return v
}

