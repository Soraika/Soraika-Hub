/**
 * Mikan ↔ Bangumi 身份映射（`mikan_bgm_map`）—— 全库唯一"不可重建"的数据
 * ---------------------------------------------------------------------------
 * 为什么单独一张表：`anime` 只是"排期 + 展示"的产物，随时可以重建（重扫 Mikan）；
 * 但「哪个 mikan_id 对应哪个 bgm_id」丢了就要重扫几千个页面。拆开之后重建 anime
 * 不碰它，备份也只需要带走它。
 *
 * 语义变化（相对旧的 `anime.bgm_miss_count`）：
 *   · 不再记"失败了几次" —— 有没有 bgm 链接是**事实**，不是失败次数；
 *   · 用 `checked_at`（上次尝试的时间）做退避：没有链接的隔 30 天再试一次。
 */
import { db, val } from './index.js'

/** 没链接的隔多久再试（毫秒）：和原来 missRetryMs 的语义一致，只是不再计数 */
export const RETRY_AFTER_MS = 30 * 24 * 60 * 60 * 1000

const stmt = {
  byMikan: db.prepare('SELECT * FROM mikan_bgm_map WHERE mikan_id = ?'),
  byBgm: db.prepare('SELECT * FROM mikan_bgm_map WHERE bgm_id = ?'),
  /** 排期落库时顺手登记身份（已有就只更新标题；bgm_id 用 COALESCE，不覆盖已解析出的） */
  upsert: db.prepare(`
    INSERT INTO mikan_bgm_map (mikan_id, bgm_id, title_mikan, checked_at, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?)
    ON CONFLICT(mikan_id) DO UPDATE SET
      bgm_id      = COALESCE(excluded.bgm_id, mikan_bgm_map.bgm_id),
      title_mikan = COALESCE(excluded.title_mikan, mikan_bgm_map.title_mikan),
      updated_at  = excluded.updated_at
  `),
  /** 认领一条待确认映射的（CAS：checked_at 仍是读到的值才算抢到） */
  nextPending: db.prepare(`
    SELECT * FROM mikan_bgm_map
    WHERE bgm_id IS NULL AND (checked_at IS NULL OR checked_at < ?)
    ORDER BY checked_at IS NOT NULL, checked_at ASC, CAST(mikan_id AS INTEGER) DESC
    LIMIT 1
  `),
  claim: db.prepare('UPDATE mikan_bgm_map SET checked_at = ? WHERE mikan_id = ? AND bgm_id IS NULL AND checked_at IS ?'),
  /** 记「试过了」（成功或失败都写时间；成功时同时写 bgm_id） */
  markChecked: db.prepare('UPDATE mikan_bgm_map SET checked_at = ?, bgm_id = COALESCE(?, bgm_id), updated_at = ? WHERE mikan_id = ?'),
  countPending: db.prepare(`
    SELECT COUNT(*) AS n FROM mikan_bgm_map
    WHERE bgm_id IS NULL AND (checked_at IS NULL OR checked_at < ?)
  `),
  /** 没有链接、正在冷却的（看板：区分"队列空"和"上游确实没有"） */
  countCooling: db.prepare(`
    SELECT COUNT(*) AS n FROM mikan_bgm_map
    WHERE bgm_id IS NULL AND checked_at IS NOT NULL AND checked_at >= ?
  `),
  countAll: db.prepare('SELECT COUNT(*) AS n FROM mikan_bgm_map'),
  /** 扫描用：已经扫到过的 mikan id（增量） */
  scannedIds: db.prepare('SELECT mikan_id FROM mikan_bgm_map'),
  maxMikanId: db.prepare('SELECT MAX(CAST(mikan_id AS INTEGER)) AS maxId FROM mikan_bgm_map'),
  getScan: db.prepare('SELECT watermark FROM mikan_scan WHERE id = 1'),
  setScan: db.prepare(`
    INSERT INTO mikan_scan (id, watermark, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET watermark = excluded.watermark, updated_at = excluded.updated_at
  `),
}

export const getMapByMikan = (mikanId) => stmt.byMikan.get(val(mikanId)) ?? null
export const getMapByBgm = (bgmId) => stmt.byBgm.get(val(bgmId)) ?? null

/** 排期落库时登记身份（幂等；不改已解析出的 bgm_id） */
export function rememberMikan(mikanId, title = null, bgmId = null) {
  if (!mikanId) return
  const now = Date.now()
  stmt.upsert.run(val(mikanId), val(bgmId), val(title), now, now)
}

/** 记录一次映射尝试的结果（bgmId 为空 = 这次没拿到，等 30 天再试） */
export function markMapChecked(mikanId, bgmId = null) {
  if (!mikanId) return
  const now = Date.now()
  stmt.markChecked.run(now, val(bgmId), now, val(mikanId))
}

/** 认领一条待确认映射（CAS 抢占；没有就返回 null） */
export function claimNextMapPending(now = Date.now()) {
  const row = stmt.nextPending.get(now - RETRY_AFTER_MS)
  if (!row) return null
  const claimed = stmt.claim.run(now, val(row.mikan_id), val(row.checked_at))
  return claimed.changes === 1 ? { ...row, checked_at: now } : null
}

/** 还等着确认映射的条数（与 claimNextMapPending 同一谓词） */
export const countMapPending = (now = Date.now()) => stmt.countPending.get(now - RETRY_AFTER_MS)?.n ?? 0

/** 没有 bgm 链接、正在冷却的条数 */
export const countMapCooling = (now = Date.now()) => stmt.countCooling.get(now - RETRY_AFTER_MS)?.n ?? 0

/** 映射表总条数 */
export const countMapAll = () => stmt.countAll.get()?.n ?? 0

/** 已扫过的 mikan id（扫描脚本做增量用） */
export const listScannedMikanIds = () => stmt.scannedIds.all().map((row) => row.mikan_id)

/** 目前见过的最大 mikan id（尾部扫描的水位起点） */
export const maxScannedMikanId = () => Number(stmt.maxMikanId.get()?.maxId) || 0

/**
 * 批量导入「别处生成的映射」（老版本导出的 `data/mikan-bgm-map.jsonl`）
 * ---------------------------------------------------------------------------
 * 为什么要有这条：`mikan_bgm_map` 是全库**唯一不可重建**的数据，而它是靠逐页扫描攒出来的
 * （5400 个 mikan id × 1 次请求）。换库 / 换部署时如果只能重扫，代价是几十分钟到几个小时 ——
 * 所以允许把已经生成的那份直接带过来。幂等：只补空的 bgm_id，不覆盖已解析出的值。
 * @param {Array<{mikanId:string|number, bgmId?:string|number|null, title?:string}>} rows
 * @returns {{inserted:number, filled:number, skipped:number}}
 */
export function importMapRows(rows = []) {
  const out = { inserted: 0, filled: 0, skipped: 0 }
  if (!rows?.length) return out
  const before = new Set(listScannedMikanIds().map(String))
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows) {
      const mikanId = String(row?.mikanId ?? row?.mikan_id ?? '').trim()
      if (!mikanId) continue
      const bgmId = row?.bgmId ?? row?.bgm_id ?? null
      const title = row?.title ?? row?.title_mikan ?? null
      const existed = before.has(mikanId)
      stmt.upsert.run(val(mikanId), val(bgmId), val(title), now, now)
      if (!existed) out.inserted++
      else if (bgmId) out.filled++
      else out.skipped++
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return out
}

/** 扫描水位（没扫过就是 0） */
export const getScanWatermark = () => Number(stmt.getScan.get()?.watermark) || 0

/** 记扫描水位（只前进，不后退） */
export function setScanWatermark(watermark) {
  const value = Number(watermark) || 0
  const current = getScanWatermark()
  if (value <= current) return current
  stmt.setScan.run(value, Date.now())
  return value
}
