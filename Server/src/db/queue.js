/**
 * 队列语义 —— 后台队列的「谓词 / 取任务 / 认领 / 计数 / 退避」
 * ---------------------------------------------------------------------------
 * 触发① 补齐映射：**在 `mikan_bgm_map` 上跑** —— 谁还没确认出 bgm_id 就查谁
 *   （Mikan 详情页 → bgm_id）。没有链接的（老番常见）隔 30 天再试，不记失败次数。
 * 触发② 每日更新：`anime.year = 当年` 且档案早于最近一次到点时刻
 * 触发③ 系列链：`series_checked_at IS NULL`
 * 触发④ 档案补齐：有 `bgm_id` 但评分/标签/简介还空着
 *
 * 为什么①挪到映射表上：`anime` 是"排期 + 展示"的产物（可重建），而"哪个 mikan_id
 * 对应哪个 bgm_id"是不可重建的身份。队列跟着身份走，才不会因为重建排期表而重扫几千页。
 *
 * 队列规范的 7 条见 CONVENTIONS.md §5；消费者：jobs/worker.js、jobs/enrich.js、
 * rout/index.js（看板计数）。
 */
import { config } from '../config.js'
import { db, val } from './index.js'
import { claimNextMapPending, countMapCooling, countMapPending, markMapChecked } from './map.js'

/** 每日更新队列里「今年」那一批的年份（staleYear 未配置时取当年） */
const staleYear = () => config.worker.staleYear || new Date().getFullYear()

const stmt = {
  /** 触发②取一条：今年 + 早于分界线 + 最久没刷过的 */
  nextStale: db.prepare(`
    SELECT * FROM anime
    WHERE bgm_id IS NOT NULL AND year = ?
      AND (bgm_checked_at IS NULL OR bgm_checked_at < ?)
    ORDER BY bgm_checked_at IS NOT NULL, bgm_checked_at ASC, id DESC
    LIMIT 1
  `),
  countStale: db.prepare(`
    SELECT COUNT(*) AS n FROM anime
    WHERE bgm_id IS NOT NULL AND year = ? AND (bgm_checked_at IS NULL OR bgm_checked_at < ?)
  `),
  /** 成功刷新档案：标记时间（每日更新/档案队列的退避窗口） */
  markChecked: db.prepare('UPDATE anime SET bgm_checked_at = ? WHERE id = ?'),
}

/** 失败退避的「冷却期起点」参数：超过这个时刻没试过，才重新进入队列（档案侧） */
const retryBefore = () => Date.now() - config.worker.missRetryMs

/**
 * 认领一条「待确认映射」（CAS 抢占；多进程不重复请求上游）
 * @returns {{ mikan_id: string, bgm_id: null, title_mikan: string|null, checked_at: number }|null}
 */
export const claimNextMissingBgm = () => claimNextMapPending()

/** 手动补齐全量队列（CLI 用）：直接列出还没确认的映射 */
export function listMissingBgm(limit = 20) {
  return db
    .prepare(
      `SELECT * FROM mikan_bgm_map
        WHERE bgm_id IS NULL AND (checked_at IS NULL OR checked_at < ?)
        ORDER BY checked_at IS NOT NULL, checked_at ASC, CAST(mikan_id AS INTEGER) ASC
        LIMIT ?`,
    )
    .all(Date.now() - 30 * 24 * 60 * 60 * 1000, Number(limit) || 20)
}

/** 还在等确认的映射条数（与 claimNextMissingBgm 同一谓词） */
export const countMissingBgm = () => countMapPending()

/**
 * 没有 bgm 链接、正在冷却的条数（看板用它区分「队列空」与「上游确实没有」）
 * 名字保留 `countGaveUp`：`/api/health` 的 worker.missing.gaveUp 一直用这个键。
 */
export const countGaveUp = () => countMapCooling()

/** 档案刷新成功（anime 行）：写 `bgm_checked_at`，档案队列据此退避 */
export const markBgmChecked = (id) => stmt.markChecked.run(Date.now(), val(id))

/**
 * 映射尝试失败（Mikan 详情页 404 / 没挂 BGM 链接）：只记时间，不记次数
 * 参数是 **mikan_id**（映射表的键），不是 anime 主键。
 */
export const markBgmMiss = (mikanId) => markMapChecked(mikanId, null)

/**
 * 触发②取一条：今年的番里、上次刷新早于 olderThan 的一条
 * @param {{ olderThan: number }} params olderThan 由 jobs/enrich.js 按「最近一次到点时刻」算好传入
 */
export const takeNextStale = ({ olderThan }) => stmt.nextStale.get(val(staleYear()), val(olderThan)) ?? null

/** 每日更新队列还剩多少条 */
export const countStale = ({ olderThan }) => stmt.countStale.get(val(staleYear()), val(olderThan))?.n ?? 0

/* ── 触发④：档案补齐（有 bgm_id，但评分 / 标签 / 简介还空着）─────────────────────
 * 为什么必须有这条：**扫描进来的行只有 bgm_id 和标题**（实测 2607/3237 条，占八成），
 * 而上面两条队列都够不着它们：
 *   · 触发① 要 `bgm_id IS NULL`  —— 这些行有 bgm_id
 *   · 触发② 要 `year = 当年`     —— 扫描写入时 year/season 一律留空（CONVENTIONS §10.3）
 * 结果就是老番季的卡片没有评分、点进去面板也是空的（"有 bgm_id 却没档案"）。
 *
 * 谓词：`bgm_id IS NOT NULL AND (score/tags/summary 任一为空)` + 退避窗口 ——
 *   补过之后仍然缺的（上游真没评分）隔 missRetryMs 再试一次，不会变成死循环。
 * 处理：`jobs/enrich.js#enrichOne` 认得 `row.bgm_id` → **跳过 Mikan 详情页**，只打 Bangumi 一次。
 */
const archiveStmt = {
  next: db.prepare(`
    SELECT * FROM v_anime
    WHERE bgm_id IS NOT NULL
      AND (score IS NULL OR tags IS NULL OR summary IS NULL)
      AND (bgm_checked_at IS NULL OR bgm_checked_at < ?)
    ORDER BY bgm_checked_at IS NOT NULL, bgm_checked_at ASC, id DESC
    LIMIT 1
  `),
  /** 认领（CAS）：只有 bgm_checked_at 仍是刚才读到的值才算抢到 */
  claim: db.prepare(`
    UPDATE anime SET bgm_checked_at = ?
    WHERE id = ? AND bgm_id IS NOT NULL AND bgm_checked_at IS ?
  `),
  count: db.prepare(`
    SELECT COUNT(*) AS n FROM v_anime
    WHERE bgm_id IS NOT NULL AND (score IS NULL OR tags IS NULL OR summary IS NULL)
      AND (bgm_checked_at IS NULL OR bgm_checked_at < ?)
  `),
}

/** 认领一条「有 bgm_id 但缺档案」的（CAS 抢占；多进程同时跑不重复请求上游） */
export function claimNextArchive() {
  const row = archiveStmt.next.get(val(retryBefore()))
  if (!row) return null
  const claimed = archiveStmt.claim.run(Date.now(), val(row.id), val(row.bgm_checked_at))
  return claimed.changes === 1 ? { ...row, bgm_checked_at: Date.now() } : null
}

/** 还缺档案的条数（看板用；与 claimNextArchive 同一谓词，保证口径一致） */
export const countArchivePending = () => archiveStmt.count.get(val(retryBefore()))?.n ?? 0

/* ── 触发③：系列链补齐 —— 「还没算过系列」的作品走一次链（CONVENTIONS.md §10.1）─────
 *
 * 与上面两个触发不同的地方，逐条对上 §5 的七条：
 *   谓词 : `bgm_id IS NOT NULL AND series_checked_at IS NULL`（谁没算过算谁）
 *   认领 : 把 `series_checked_at` 置 **-1（哨兵 = 处理中）**，CAS 语义：只有还是 NULL 才算抢到
 *   处理 : jobs/series.js#fillSeriesFor（走链 + AI 归一 + 落库），一条一个事务边界、幂等
 *   退出 : 成功由 fillSeriesFor 写入真实时间；AI 没配/失败 → release 回 NULL（下轮再来）
 *   退避 : 失败由 worker 里的"冷却"处理（连续失败指数退避），不在这里做
 *   恢复 : worker 启动时 resetStaleSeriesClaims() 把上次崩在中间的 -1 清回 NULL
 *   可观测: countSeriesPending / countSeriesDone 进 /api/health 的 worker 段
 *
 * 为什么用 -1 而不是另开一列：这张表已经为"系列"加了 6 列，值为负的时间戳不可能出现，
 * 且谓词是 `IS NULL`（-1 天然进不了队列），不新增列就能拿到"正在处理"的语义。
 */
const seriesStmt = {
  next: db.prepare(`
    SELECT * FROM anime
    WHERE bgm_id IS NOT NULL AND series_checked_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `),
  claim: db.prepare('UPDATE anime SET series_checked_at = -1 WHERE id = ? AND series_checked_at IS NULL'),
  release: db.prepare('UPDATE anime SET series_checked_at = NULL WHERE id = ? AND series_checked_at = -1'),
  resetStale: db.prepare('UPDATE anime SET series_checked_at = NULL WHERE series_checked_at = -1'),
  countPending: db.prepare('SELECT COUNT(*) AS n FROM anime WHERE bgm_id IS NOT NULL AND series_checked_at IS NULL'),
  countDone: db.prepare('SELECT COUNT(*) AS n FROM anime WHERE series_checked_at IS NOT NULL'),
}

/**
 * 认领一条「待算系列」（CAS 抢占；多进程同时跑也不会重复走链/重复花钱）
 * @returns {object|null} 抢到的那行；没任务 / 被别的进程抢先 → null
 */
export function claimNextSeriesPending() {
  const row = seriesStmt.next.get()
  if (!row) return null
  const claimed = seriesStmt.claim.run(val(row.id))
  return claimed.changes === 1 ? { ...row, series_checked_at: -1 } : null
}

/** 放回队列（AI 没配 / 这次失败）：把它从"处理中"改回"待算" */
export const releaseSeries = (id) => seriesStmt.release.run(val(id))

/** 启动时清理上次崩在中间留下的"处理中"标记 → 返回清掉的条数 */
export const resetStaleSeriesClaims = () => seriesStmt.resetStale.run().changes

/** 还没算系列的条数 */
export const countSeriesPending = () => seriesStmt.countPending.get()?.n ?? 0

/** 已经算系列的条数 */
export const countSeriesDone = () => seriesStmt.countDone.get()?.n ?? 0
