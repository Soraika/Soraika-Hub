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
 */
const schemaSql = readFileSync(resolve(import.meta.dirname, 'schema.sql'), 'utf8')
db.exec(schemaSql)

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

