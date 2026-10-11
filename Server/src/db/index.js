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
 * 结构性迁移（**必须在建表之前跑**，否则会先被建索引/建表语句撞上）
 * ---------------------------------------------------------------------------
 * 字幕组从「单表」升级为「实体表 + 关联表」：
 * 老结构把字幕组直接挂在作品上（subgroup 一张表带 anime_id），468 部作品攒了 1930 行，
 * 同一个字幕组被重复存几十上百次 —— 库里看上去全是重复名字（新结构见 schema.sql）。
 * 判定依据：旧表有 anime_id 列（新表没有）。
 * 为什么必须先于 schema.sql：schema 里要给新列 mikan_subgroup_id 建唯一索引，
 * 而老表还在的时候 `CREATE TABLE IF NOT EXISTS` 会被跳过、索引却照建 → 直接报「没有这一列」。
 * 数据怎么处理：**直接重建、不迁移**。字幕组只是 Mikan 详情页的镜像，
 * 面板打开时 api/pages/anime.js 会现场抓回来补上，丢了不影响任何功能。
 */
function normalizeSubgroups() {
  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subgroup'`).get()
  if (!hasTable) return
  const cols = new Set(db.prepare('PRAGMA table_info(subgroup)').all().map((c) => c.name))
  if (!cols.has('anime_id')) return // 已经是新结构

  const dropped = db.prepare('SELECT COUNT(*) AS n FROM subgroup').get().n
  db.exec('DROP TABLE IF EXISTS subgroup') // 老表的索引会跟着一起没
  db.exec('DROP TABLE IF EXISTS anime_subgroup')
  logger.warn({ dropped }, 'db.migrate subgroups-normalized（重建为实体 + 关联，旧行丢弃）')
}

normalizeSubgroups()

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
 * 顺序：normalizeSubgroups → 补列 → schema.sql ✅
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

