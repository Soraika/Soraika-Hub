/**
 * 后台守护进程 —— 常驻补齐「作品档案」，并定时重查评分
 * ---------------------------------------------------------------------------
 * 循环（永不退出，除收到停止信号）：
 *   1. 从待补队列认领一条 → 补齐（Mikan 详情页 → bgmid + 字幕组；Bangumi → 评分/标签/简介）
 *      → 落库 → 间隔 gapMs → 再认领下一条
 *   2. 队列空了：趁空档做一轮「定时重查评分」（只覆盖最近 N 季、每轮限量），然后休眠 idleMs
 *
 * 两种跑法：
 *   · 跟随 API 服务（默认，WORKER_INLINE=1）：不用多开终端
 *   · 独立守护：把 WORKER_INLINE 设为 0，然后 `npm run worker`（前后端重启不影响它）
 *   两种同时跑也安全 —— 任务用 CAS 认领，不会重复请求上游。
 *
 * 状态会同步到 workerState，`GET /api/health` 里能看到进度。
 */
import { pathToFileURL } from 'node:url'
import { loadStoredSettings } from '../api/pages/settings.js'
import { config } from '../config.js'
import { getDumpState } from '../db/dump.js'
import {
  claimNextArchive,
  claimNextMissingBgm,
  claimNextSeriesPending,
  countArchivePending,
  countGaveUp,
  countMissingBgm,
  countSeriesDone,
  countSeriesPending,
  countStale,
  releaseSeries,
  resetStaleSeriesClaims,
} from '../db/queue.js'
import { logger } from '../lib/logger.js'
import { enrichOne, lastDailyBoundary, refreshStaleOne } from './enrich.js'
import { updateDump } from './dump-update.js'
import { fillSeriesFor } from './series.js'

/** 运行状态（模块内私有：外部只能通过 getWorkerState() 拿快照，避免被随手改） */
const workerState = {
  running: false,
  startedAt: 0,
  /** 最后一次「最后防线」兜住的异常（`/api/health` 里看得到；非 null 就说明有 bug 要修） */
  lastError: null,
  /** 触发①：补齐档案（bgm_id IS NULL，不限季） */
  missing: { processed: 0, enriched: 0, noBgmId: 0, failed: 0, pending: 0, gaveUp: 0 },
  /** 触发②：今年的番剧每日更新（每天固定时刻开始刷一遍整份档案） */
  daily: { at: '', year: 0, boundaryAt: 0, refreshed: 0, due: 0, doneAt: 0 },
  /** 触发③：系列链补齐（新作品入库后算一次；老系列不主动重算 —— 见 CONVENTIONS.md §10.1） */
  series: { processed: 0, done: 0, skipped: 0, pending: 0, doneTotal: 0, cooldownUntil: 0 },
  /** 离线 dump 的自动更新（每天到点检查一次；下载/导入是后台异步跑的，不挡其它队列） */
  dump: {
    at: '',
    checkedAt: 0,
    importedAt: 0,
    name: '',
    running: false,
    lastError: null,
    cooldownUntil: 0,
  },
  /** 三个队列都空了几轮 */
  idleCycles: 0,
  lastError: null,
}

/** 给 /api/health 用的只读快照（structuredClone：调用方拿到的是副本，改不动内部状态） */
export const getWorkerState = () => structuredClone(workerState)

let stopped = false
let running = false
/** 触发③的失败退避：连续失败就指数拉长冷却（最多 10 分钟），别在上游抖动时反复打 */
let seriesFailStreak = 0
let seriesCooldownUntil = 0
/** dump 更新的失败退避（最多 6 小时；换进程后由 dump_state.checked_at 决定还要不要再查） */
let dumpFailStreak = 0
/** 循环的 promise（优雅停机时等它退出） */
let loopDone = null
/** 唤醒正在休眠的循环：停机时不用干等一个 idleMs */
let wake = null

/** 可被 stopWorker 立刻打断的 sleep（等待时长最长的就是 idleMs，不打断会让停机卡 30 秒） */
function pause(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null
      resolve()
    }, ms)
    wake = () => {
      clearTimeout(timer)
      wake = null
      resolve()
    }
  })
}

/** 启动守护进程（幂等：已在跑就直接返回） */
export function startWorker({ log = logger } = {}) {
  if (running) return
  running = true
  stopped = false
  workerState.running = true
  workerState.startedAt = Date.now()
  // 上次崩在中间的行（series_checked_at = -1 哨兵）放回队列，否则它们会一直卡在"处理中"
  const released = resetStaleSeriesClaims()
  workerState.series.pending = countSeriesPending()
  workerState.series.doneTotal = countSeriesDone()
  if (released) log.warn({ released }, 'worker.series release-stale')
  // dump 上次检查时间来自库（进程重启不该重新打一次索引）
  const dumpState = getDumpState()
  workerState.dump.checkedAt = Number(dumpState?.checked_at) || 0
  workerState.dump.importedAt = Number(dumpState?.imported_at) || 0
  workerState.dump.name = dumpState?.name || ''
  workerState.dump.at = config.bgm?.dumpCheckAt || ''
  log.info(
    {
      gapMs: config.worker.gapMs,
      idleMs: config.worker.idleMs,
      dailyAt: config.worker.dailyAt,
      staleYear: config.worker.staleYear,
      missLimit: config.worker.missLimit,
      missRetryMs: config.worker.missRetryMs,
      pending: countMissingBgm(),
      gaveUp: countGaveUp(),
      archivePending: countArchivePending(),
      seriesPending: workerState.series.pending,
    },
    'worker.start ok',
  )
  void (loopDone = runLoop(log).finally(() => {
    running = false
    workerState.running = false
  }))
}

/**
 * 停止守护进程（优雅停机用）
 * 立刻中断当前休眠，等**手上这一条**处理完就返回 —— 不会让进程卡一个 idleMs
 * @returns {Promise<void>}
 */
export function stopWorker() {
  stopped = true
  wake?.()
  return loopDone ?? Promise.resolve()
}

/**
 * 自愈包装：`loop` 里任何一步意外抛出，都不许把守护进程打死
 * ---------------------------------------------------------------------------
 * 冒烟测踩到过：上游 404 从 `fillSeriesFor` 抛穿 → loop 退出 → **整个进程死掉**（后台静默停摆，
 * 表面上"服务在跑"但队列再也不推进）。所以这里再兜一层：记日志 → 清掉可能残留的"处理中"认领
 * → 退避后重新进入 loop。
 *
 * 各条的失败仍然由各条自己处理（enrichOne / fillSeriesFor 都返回 outcome 而不是抛），
 * 这一层是**最后一道**防线：一旦命中就说明某处漏了 try，属于要修的 bug。
 */
async function runLoop(log) {
  while (!stopped) {
    try {
      await loop(log)
      return // loop 正常退出（stopped）→ 一起收工
    } catch (err) {
      workerState.lastError = { at: Date.now(), code: err?.code ?? '', message: err?.message ?? String(err) }
      log.error({ code: err?.code, status: err?.detail?.status, err: err?.message }, 'worker.loop crash')
      const released = resetStaleSeriesClaims()
      if (released) log.warn({ released }, 'worker.loop release-stale')
      if (stopped) return
      await pause(Math.max(config.worker.gapMs, 3000))
    }
  }
}

/**
 * 离线 dump 的每日检查（**发射后不管**，不阻塞主循环）
 * ---------------------------------------------------------------------------
 * 为什么异步：下载 450MB 可能十几分钟，await 它会把补齐 / 每日更新全卡住，
 * 优雅停机也得等它跑完。这里只判断"到点了没"，真正的工作在后台跑，
 * 状态写进 `workerState.dump`（`/api/health` 能看到）。
 *
 * 失败退避：10 分钟 → 20 → 40 … 最多 6 小时 —— 上游挂了不能每轮都去打索引。
 * 检查失败也会写 `checkedAt`（否则 30 秒一轮的循环会疯狂重试）。
 */
function maybeUpdateDump(log) {
  if (!config.bgm?.dumpAuto || workerState.dump.running) return
  const boundary = lastDailyBoundary(new Date(), config.bgm.dumpCheckAt)
  if (workerState.dump.checkedAt >= boundary) return
  if (Date.now() < workerState.dump.cooldownUntil) return

  workerState.dump.running = true
  workerState.dump.at = config.bgm.dumpCheckAt
  void (async () => {
    try {
      const res = await updateDump({ log })
      workerState.dump.checkedAt = Date.now()
      workerState.dump.lastError = null
      dumpFailStreak = 0
      if (res.index?.name) workerState.dump.name = res.index.name
      if (res.status === 'imported') workerState.dump.importedAt = Date.now()
    } catch (err) {
      workerState.dump.checkedAt = Date.now()
      workerState.dump.lastError = err?.message || String(err)
      dumpFailStreak++
      const cooldown = Math.min(6 * 60 * 60 * 1000, 10 * 60 * 1000 * 2 ** (dumpFailStreak - 1))
      workerState.dump.cooldownUntil = Date.now() + cooldown
      log.warn({ err: workerState.dump.lastError, cooldownMs: cooldown }, 'worker.dump fail backoff')
    } finally {
      workerState.dump.running = false
    }
  })()
}

async function loop(log) {
  while (!stopped) {
    let worked = false

    // ── 触发①：补齐档案（两条队列，顺序即优先级）──────────────────────────
    //   ① 没有 bgmId 的（新番、用户正在看）→ ② 有 bgmId 但缺评分/标签/简介的
    //   （扫描进来的老番，占八成 —— 这条以前没有，导致老番季的卡片一直没评分）
    const missing = claimNextMissingBgm() ?? claimNextArchive()
    if (missing) {
      const outcome = await enrichOne(missing, log)
      workerState.missing.processed++
      if (outcome === 'enriched') workerState.missing.enriched++
      else if (outcome === 'noBgmId') workerState.missing.noBgmId++
      else workerState.missing.failed++
      workerState.missing.pending = countMissingBgm()
      workerState.missing.gaveUp = countGaveUp()
      worked = true
      await pause(config.worker.gapMs)
    }

    // ── 离线 dump 的每日检查（异步：下载/导入不挡其它队列）──────────────
    maybeUpdateDump(log)

    // ── 触发②：今年的番剧每日更新（整份档案重刷）─────────────────────────
    // 三个触发**每轮各推进一条**：若改成「先清空补齐队列再处理每日更新」，
    // 补齐队列长期非空时每日更新会被饿死 —— 这是刻意避免的调度方式。
    if (await refreshStaleOne({ log })) {
      workerState.daily.at = config.worker.dailyAt
      workerState.daily.year = config.worker.staleYear || new Date().getFullYear()
      workerState.daily.boundaryAt = lastDailyBoundary()
      workerState.daily.refreshed++
      workerState.daily.doneAt = 0
      worked = true
      await pause(config.worker.gapMs)
    } else if (!workerState.daily.doneAt) {
      workerState.daily.at = config.worker.dailyAt
      workerState.daily.doneAt = Date.now()
      log.info(
        { year: workerState.daily.year || new Date().getFullYear(), dailyAt: config.worker.dailyAt, refreshed: workerState.daily.refreshed },
        'worker.daily done',
      )
    }

    // ── 触发③：系列链补齐（新作品入库后算一次 —— 见 CONVENTIONS.md §10.1）──────
    // 三个触发**每轮各推进一条**（同上：谁也不许被饿死）。
    // AI 没配就整段跳过；失败按连续失败次数指数退避（5s→10s→… 最多 10 分钟），
    // 免得上游抖动时一秒打三次 AI 白花钱。
    if (config.ai.enabled && Date.now() >= seriesCooldownUntil) {
      const seriesRow = claimNextSeriesPending()
      if (seriesRow) {
        const outcome = await fillSeriesFor(seriesRow, { log })
        workerState.series.processed++
        if (outcome === 'done') {
          workerState.series.done++
          seriesFailStreak = 0
          seriesCooldownUntil = 0
        } else {
          // 'skipped'（AI 这次失败）/ 'ai-disabled' / 'no-bgm'：都放回队列，下轮再看
          workerState.series.skipped++
          releaseSeries(seriesRow.id)
          if (outcome === 'skipped') {
            seriesFailStreak++
            seriesCooldownUntil = Date.now() + Math.min(600000, 5000 * 2 ** seriesFailStreak)
          }
        }
        workerState.series.pending = countSeriesPending()
        workerState.series.doneTotal = countSeriesDone()
        workerState.series.cooldownUntil = seriesCooldownUntil
        worked = true
        await pause(config.worker.gapMs)
      }
    }

    // ── 三个队列都没有任务：休眠一会儿再看 ───────────────────────────────
    if (!worked) {
      const year = config.worker.staleYear || new Date().getFullYear()
      workerState.daily.due = countStale({ year, olderThan: lastDailyBoundary() })
      workerState.idleCycles++
      workerState.missing.pending = countMissingBgm()
      workerState.missing.gaveUp = countGaveUp()
      workerState.missing.archivePending = countArchivePending()
      workerState.series.pending = countSeriesPending()
      workerState.series.doneTotal = countSeriesDone()
      await pause(config.worker.idleMs)
    }
  }

  running = false
  workerState.running = false
  log.info({ processed: workerState.missing.processed, enriched: workerState.missing.enriched }, 'worker.stop ok')
}

// ── 直接执行时作为独立守护进程运行（npm run worker）────────────────────────
const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isCli) {
  // 独立进程也要吃设置页里的覆盖项（worker.* 那几个参数就在那里改）——必须在 startWorker 之前
  const overridden = loadStoredSettings()
  if (config.worker.inline) {
    logger.warn({ inline: true }, 'worker.cli inline-already-on')
  }
  logger.info(
    { pending: countMissingBgm(), gaveUp: countGaveUp(), settingsOverridden: overridden },
    'worker.cli start',
  )
  startWorker()
  const bye = () => {
    stopWorker()
    setTimeout(() => process.exit(0), 200)
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}
