/**
 * 队列语义 —— 两个后台队列的「谓词 / 取任务 / 认领 / 计数 / 退避」
 * ---------------------------------------------------------------------------
 * 触发① 补齐：`bgm_id IS NULL`（不限季，把缺失的作品档案补上）
 * 触发② 每日更新：`year = 当年` 且 `bgm_checked_at` 早于最近一次到点时刻
 * 队列规范的 7 条（谓词/认领/处理/退出/退避/恢复/可观测）见 CONVENTIONS.md §5。
 *
 * 为什么单独成文件：表 CRUD（anime.js）与「谁该被处理、怎么抢占、什么时候放弃」
 * 是两类职责 —— 队列策略会随运行反馈反复调整，不该混在数据访问层里。
 * 消费者：jobs/worker.js（循环）、jobs/enrich.js（取一条）、rout/index.js（看板计数）。
 */
import { config } from '../config.js'
import { db, val } from './index.js'

/** 每日更新队列里「今年」那一批的年份（staleYear 未配置时取当年） */
const staleYear = () => config.worker.staleYear || new Date().getFullYear()

const stmt = {
  /**
   * 触发①取一条：未查过的优先 → 查得最久的 → id 大的（= 最近入库的那一季，先补用户正在看的）
   * 关键：连续拿不到 bgmId 的行（Mikan 详情页确实没挂链接）超限后**退出队列**，
   * 否则它永远满足 `bgm_id IS NULL`，会让队列空转、每轮白打一次上游。
   */
  nextMissing: db.prepare(`
    SELECT * FROM anime
    WHERE mikan_id IS NOT NULL AND bgm_id IS NULL
      AND (COALESCE(bgm_miss_count, 0) < ? OR bgm_checked_at IS NULL OR bgm_checked_at < ?)
    ORDER BY bgm_checked_at IS NOT NULL, bgm_checked_at ASC, id DESC
    LIMIT 1
  `),
  /** 认领（CAS）：只有 bgm_checked_at 仍是刚才读到的值才算抢到 —— 多进程也不会重复请求上游 */
  claimMissing: db.prepare(`
    UPDATE anime SET bgm_checked_at = ?
    WHERE id = ? AND mikan_id IS NOT NULL AND bgm_id IS NULL AND bgm_checked_at IS ?
  `),
  /** 拿不到 bgmId：失败计数 +1（超限后改成隔 missRetryHours 再试一次） */
  bumpMiss: db.prepare(`
    UPDATE anime SET bgm_miss_count = COALESCE(bgm_miss_count, 0) + 1, bgm_checked_at = ?
    WHERE id = ?
  `),
  /** 成功补齐：标记时间 + 清零失败计数 */
  markChecked: db.prepare('UPDATE anime SET bgm_checked_at = ?, bgm_miss_count = 0 WHERE id = ?'),
  /** 手动补齐全量队列（跳过已超限的） */
  missingList: db.prepare(`
    SELECT * FROM anime
    WHERE mikan_id IS NOT NULL AND bgm_id IS NULL
      AND (COALESCE(bgm_miss_count, 0) < ? OR bgm_checked_at IS NULL OR bgm_checked_at < ?)
    ORDER BY bgm_checked_at IS NOT NULL, bgm_checked_at ASC, id ASC
    LIMIT ?
  `),
  /** 还能补的有多少（看板）：与 nextMissing 同一谓词，保证「队列空」的判断一致 */
  countMissing: db.prepare(`
    SELECT COUNT(*) AS n FROM anime
    WHERE mikan_id IS NOT NULL AND bgm_id IS NULL
      AND (COALESCE(bgm_miss_count, 0) < ? OR bgm_checked_at IS NULL OR bgm_checked_at < ?)
  `),
  /** 已放弃的（上游确实没有 bgmId）：看板据此区分「队列空」与「补不了」 */
  countGaveUp: db.prepare(`
    SELECT COUNT(*) AS n FROM anime
    WHERE mikan_id IS NOT NULL AND bgm_id IS NULL AND COALESCE(bgm_miss_count, 0) >= ?
  `),
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
}

/** 失败退避的「冷却期起点」参数：超过这个时刻没试过，才重新进入队列 */
const retryBefore = () => Date.now() - config.worker.missRetryHours * 3600 * 1000

/**
 * 认领一条待补任务（CAS 抢占）
 * @returns {object|null} 抢到的那行；没任务 / 被别的进程抢先 → null
 */
export function claimNextMissingBgm() {
  const row = stmt.nextMissing.get(val(config.worker.missLimit), val(retryBefore()))
  if (!row) return null
  const claimed = stmt.claimMissing.run(Date.now(), val(row.id), val(row.bgm_checked_at))
  return claimed.changes === 1 ? { ...row, bgm_checked_at: Date.now() } : null
}

/** 手动补齐全量队列（CLI 用；同样跳过已超限的） */
export const listMissingBgm = (limit = 20) =>
  stmt.missingList.all(val(config.worker.missLimit), val(retryBefore()), val(limit))

/** 还能补的条数 */
export const countMissingBgm = () =>
  stmt.countMissing.get(val(config.worker.missLimit), val(retryBefore()))?.n ?? 0

/** 上游确实没有 bgmId、已放弃重试的条数 */
export const countGaveUp = () => stmt.countGaveUp.get(val(config.worker.missLimit))?.n ?? 0

/** 补齐成功：标记时间 + 清零失败计数 */
export const markBgmChecked = (id) => stmt.markChecked.run(Date.now(), val(id))

/** 补齐失败（无链接 / 条目 404）：失败计数 +1，超限后退出队列 */
export const markBgmMiss = (id) => stmt.bumpMiss.run(Date.now(), val(id))

/**
 * 触发②取一条：今年的番里、上次刷新早于 olderThan 的一条
 * @param {{ olderThan: number }} params olderThan 由 jobs/enrich.js 按「最近一次到点时刻」算好传入
 */
export const takeNextStale = ({ olderThan }) => stmt.nextStale.get(val(staleYear()), val(olderThan)) ?? null

/** 每日更新队列还剩多少条 */
export const countStale = ({ olderThan }) => stmt.countStale.get(val(staleYear()), val(olderThan))?.n ?? 0
