/**
 * 映射扫描 / 档案补齐 任务 —— 「把缺 bgm_id 的作品在线补齐」的一次性动作
 * ---------------------------------------------------------------------------
 * 跟 dump-job 同一套形态（手动触发 + 状态查询 + 互斥），但干的事完全不同：
 *   · dump-job：下载全站离线包 → 整表重灌（离线优先的那一半）
 *   · 这里：拿 `mikan_id` 去 Mikan 详情页解析出 **bgm_id** → 再取 Bangumi 条目 →
 *     落档案（`bgm_subject`）+ 写回身份表（`mikan_bgm_map`）+ 更新 `anime.bgm_id`
 *
 * 为什么要有它：`mikan_bgm_map` 是全库唯一不可重建的数据，而它只能靠**逐页**攒
 * （5400 个 mikan id × 1 次请求）。换库 / 换部署时如果只能重扫，代价是几十分钟起 ——
 * 所以这个任务做两件事，顺序固定：
 *
 *   ① **导入已生成的映射**（`data/mikan-bgm-map.jsonl`，老版本导出的那份）——
 *      先把它灌进 `mikan_bgm_map`，能少打几千次上游
 *   ② **扫库里还缺 bgm_id 的作品**（`listAnimeMissingBgm`）——
 *      逐条走 `enrichOne`：解析 bgm_id → 补档案 → 回写映射表
 *
 * 状态只在内存（与 dump-job 一致）：「上次扫到哪」由 `mikan_bgm_map.checked_at`
 * 持久记录，重启不会重复打上游；「这一趟跑到 37%」没有必要落库。
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { countAnimeMissingBgm, listAnimeMissingBgm } from './../db/anime.js'
import { countMapAll, getScanWatermark, maxScannedMikanId, setScanWatermark } from './../db/map.js'
import { runSweep } from './sweep-mikan.js'
import { runSeasonEnum } from './season-enum.js'
import { importMapRows } from './../db/map.js'
import { enrichOne } from './enrich.js'
import { logger } from './../lib/logger.js'

/** 老版本导出的映射文件（用户本地已经生成过的那份） */
const LEGACY_MAP_FILE = 'data/mikan-bgm-map.jsonl'

const state = {
  running: false,
  trigger: '',
  /** importing（导旧映射）/ scanning（逐条补）/ done / failed */
  phase: 'idle',
  startedAt: 0,
  finishedAt: 0,
  /** 目标总数 / 已处理 —— 界面上的进度就是这两个数 */
  total: 0,
  done: 0,
  /** 各项结果计数（`noLink` = 上游页面没挂 Bangumi 链接，不是错误） */
  resolved: 0,
  noLink: 0,
  failed: 0,
  /** ① 的结果 */
  imported: { inserted: 0, filled: 0, skipped: 0, file: '' },
  lastError: null,
  /** 结束时的库状态（界面显示「映射表现在有多少条」） */
  mapCount: 0,
  stillMissing: 0,
  /** 前进扫描的区间与水位（phase='sweeping' 时有意义） */
  sweep: { from: 0, to: 0, watermark: 0, ok: 0, noLink: 0, notFound: 0, stoppedEarly: false },
  /** 季度枚举的结果（phase='enumerating' 时有意义） */
  enumerate: { fromYear: 0, toYear: 0, pages: 0, newIds: 0, items: 0, emptyQuarters: 0 },
}

export const getMapScanState = () => structuredClone(state)

/** 读老版本的 jsonl（一行一个 `{mikanId,bgmId,title,status}`）；文件不在就当没有 */
function readLegacyRows(log) {
  const file = resolve(process.cwd(), LEGACY_MAP_FILE)
  if (!existsSync(file)) return { rows: [], file: '' }
  try {
    const rows = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const text = line.trim()
      if (!text) continue
      try {
        const row = JSON.parse(text)
        if (row?.mikanId) rows.push(row)
      } catch {
        /* 坏行跳过：这是「锦上添花」的数据，不该因为一行坏 JSON 整趟失败 */
      }
    }
    return { rows, file }
  } catch (err) {
    log?.warn?.({ err: err?.message, file }, 'mapscan.legacy read fail')
    return { rows: [], file: '' }
  }
}

/**
 * 启动一次扫描（**不 await**：界面轮询 /api/map/status）
 * @param {{ limit?: number, trigger?: 'manual'|'auto', log?: object }} [options]
 * @returns {{ started: boolean, state: object, done: Promise<object>|null }}
 */
export function startMapScan({ limit = 0, trigger = 'manual', log = logger } = {}) {
  if (state.running) return { started: false, state: getMapScanState(), done: null }

  state.running = true
  state.trigger = trigger
  state.phase = 'importing'
  state.startedAt = Date.now()
  state.finishedAt = 0
  state.total = 0
  state.done = 0
  state.resolved = 0
  state.noLink = 0
  state.failed = 0
  state.imported = { inserted: 0, filled: 0, skipped: 0, file: '' }
  state.sweep = { from: 0, to: 0, watermark: 0, ok: 0, noLink: 0, notFound: 0, stoppedEarly: false }
  state.lastError = null

  const done = (async () => {
    try {
      /* ① 先导「已经生成的那份」映射 —— 能省掉几千次上游请求 */
      const legacy = readLegacyRows(log)
      if (legacy.rows.length) {
        const res = importMapRows(legacy.rows)
        state.imported = { ...res, file: legacy.file }
        log.info({ ...res, file: legacy.file }, 'mapscan.legacy imported')
      }

      /* ② 再扫库里缺 bgm_id 的作品 */
      state.phase = 'scanning'
      const targets = limit > 0 ? listAnimeMissingBgm(limit) : listAnimeMissingBgm(5000)
      state.total = targets.length
      log.info({ total: targets.length, limit }, 'mapscan.start')

      for (const row of targets) {
        if (!state.running) break // 被 stopMapScan 叫停
        /* 每条之间留一点间隔：实测一次扫几十条时有大量失败（上游对连续请求会 403/429），
           失败率 18/26 那种基本就是这个原因。250ms 一条 ≈ 4 条/秒，比后台 worker 温柔得多，
           而 300 条也就一分多钟。 */
        if (state.done > 0) await new Promise((r) => setTimeout(r, 250))

        /* enrichOne 内部自己 try/catch（失败返回 'failed'，不抛）——
           一条坏掉不该中断整趟：扫描的价值就在「把能补的都补掉」。 */
        let outcome = await enrichOne(row, log)
        /* 失败重试一次（间隔更长）：瞬时 429/超时占多数，第二次基本就过了。
           仍然是失败才计数 —— 不把「重试成功」也记成失败。 */
        if (outcome === 'failed') {
          await new Promise((r) => setTimeout(r, 900))
          outcome = await enrichOne(row, log)
        }
        if (outcome === 'enriched') state.resolved++
        else if (outcome === 'noBgmId') state.noLink++
        else state.failed++
        state.done++
      }

      state.mapCount = countMapAll()
      state.stillMissing = countAnimeMissingBgm()
      state.phase = 'done'
      log.info(
        { resolved: state.resolved, noLink: state.noLink, failed: state.failed, mapCount: state.mapCount, stillMissing: state.stillMissing },
        'mapscan.done',
      )
      return getMapScanState()
    } catch (err) {
      state.phase = 'failed'
      state.lastError = err?.message || String(err)
      log?.error?.({ err: state.lastError }, 'mapscan.fail')
      throw err
    } finally {
      state.running = false
      state.finishedAt = Date.now()
    }
  })()
  done.catch(() => {}) // 没人 await 时别变成 unhandledRejection
  return { started: true, state: getMapScanState(), done }
}

/** 叫停（正在处理的那一条会跑完，之后的循环退出） */
export function stopMapScan() {
  if (!state.running) return false
  state.running = false
  return true
}

/**
 * 向前扫描（sweep）—— 「往后多少位是空就认为没有更新了」
 * ---------------------------------------------------------------------------
 * `mikan_bgm_map` 只能靠**逐页**攒出来，而它的 id 空间是连续的（1..几千）。
 * 所以「已经扫到哪」这件事用一个**水位**表示：`mikan_scan.watermark`。
 *   ① 起点 = max(水位, 表里最大 id) + 1
 *   ② 跑 `span` 个 id（默认 300）
 *   ③ 连 `.stopAfterEmpty`（默认 40）个空页就提前收工 —— 尾巴上都是空页时
 *      没必要把剩下的几百个 id 一个个空打一遍
 *   ④ 结束时把水位推到**真正扫到的最后一个 id**（不是目标区间末尾）
 *      —— 这样「每日前进」永远从上次停的地方继续，不会一次跳过头
 *
 * 为什么要它：用户之前手工扫过 4000+，那份数据在 jsonl 里（第 ① 步已能导入），
 * 但新番会一直往后长 id。每天前进一小段，几个月就把全站盖住了 —— 不需要一口气扫完。
 * @param {{ span?: number, trigger?: 'manual'|'daily', log?: object }} [options]
 */
export function startSweep({ span = 300, trigger = 'manual', log = logger } = {}) {
  if (state.running) return { started: false, state: getMapScanState(), done: null }

  const from = Math.max(getScanWatermark(), maxScannedMikanId()) + 1
  const to = from + Math.max(1, Number(span) || 300) - 1

  state.running = true
  state.trigger = trigger
  state.phase = 'sweeping'
  state.startedAt = Date.now()
  state.finishedAt = 0
  state.total = to - from + 1
  state.done = 0
  state.resolved = 0
  state.noLink = 0
  state.failed = 0
  state.lastError = null
  state.sweep = { from, to, watermark: from - 1, ok: 0, noLink: 0, notFound: 0, stoppedEarly: false }

  const done = (async () => {
    try {
      const res = await runSweep({
        from,
        to,
        conc: 4,
        stopAfterEmpty: 40,
        log,
      })
      state.sweep = {
        from,
        to,
        watermark: to,
        ok: res.ok,
        noLink: res.noLink,
        notFound: res.notFound,
        stoppedEarly: res.stoppedEarly,
      }
      /* 水位推进到「真正处理过的最后一个 id」：用 notFound/ok/noLink 是拿不到 id 的，
         所以保守取 to（区间末尾）；提前收工时也一样 —— 区间内每个 id 都发过请求，
         只是没写库，推进水位不会丢数据（它们本来就没有页面）。 */
      const next = setScanWatermark(to)
      state.sweep.watermark = next
      state.resolved = res.ok
      state.noLink = res.noLink
      state.failed = res.failed
      state.done = state.total
      state.mapCount = countMapAll()
      state.stillMissing = countAnimeMissingBgm()
      state.phase = 'done'
      log.info({ ...state.sweep, stoppedEarly: res.stoppedEarly, seconds: res.seconds }, 'mapscan.sweep done')
      return getMapScanState()
    } catch (err) {
      state.phase = 'failed'
      state.lastError = err?.message || String(err)
      log?.error?.({ err: state.lastError }, 'mapscan.sweep fail')
      throw err
    } finally {
      state.running = false
      state.finishedAt = Date.now()
    }
  })()
  done.catch(() => {})
  return { started: true, state: getMapScanState(), done }
}

/** 当前扫到哪（水位）。界面显示「已扫到 #NNNN」 */
export const sweepWatermark = () => Math.max(getScanWatermark(), maxScannedMikanId())

/**
 * 季度枚举（**推荐入口**）—— 用排期页一次性把 mikan_id 找齐
 * ---------------------------------------------------------------------------
 * 与 `startSweep`（逐 id 试）的分工：
 *   · 季度枚举：56 页 ≈ 1 分钟，拿到全站该有的 mikan_id（顺带把历史季度的排期写进库）
 *   · 逐 id 扫描：只在「季度页漏了某个 id」时兜底，很慢
 * 所以界面上把枚举放在前面。跑完枚举再跑「扫描并补齐」就是完整的「找齐 → 补全」。
 * @param {{ fromYear?: number, toYear?: number, trigger?: 'manual'|'daily', log?: object }} [options]
 */
export function startSeasonEnum({ fromYear, toYear, trigger = 'manual', log = logger } = {}) {
  if (state.running) return { started: false, state: getMapScanState(), done: null }

  state.running = true
  state.trigger = trigger
  state.phase = 'enumerating'
  state.startedAt = Date.now()
  state.finishedAt = 0
  state.done = 0
  state.resolved = 0
  state.noLink = 0
  state.failed = 0
  state.lastError = null
  state.enumerate = { fromYear: 0, toYear: 0, pages: 0, newIds: 0, items: 0, emptyQuarters: 0 }

  const done = (async () => {
    try {
      const res = await runSeasonEnum({ fromYear, toYear, log })
      state.enumerate = {
        fromYear: res.fromYear,
        toYear: res.toYear,
        pages: res.pages,
        newIds: res.newIds,
        items: res.items,
        emptyQuarters: res.emptyQuarters,
      }
      state.total = res.pages
      state.done = res.pages
      state.mapCount = countMapAll()
      state.stillMissing = countAnimeMissingBgm()
      state.phase = 'done'
      log.info({ ...state.enumerate, seconds: res.seconds }, 'mapscan.enumerate done')
      return getMapScanState()
    } catch (err) {
      state.phase = 'failed'
      state.lastError = err?.message || String(err)
      log?.error?.({ err: state.lastError }, 'mapscan.enumerate fail')
      throw err
    } finally {
      state.running = false
      state.finishedAt = Date.now()
    }
  })()
  done.catch(() => {})
  return { started: true, state: getMapScanState(), done }
}
