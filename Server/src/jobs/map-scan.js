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
import { importMapRows, countMapAll } from './../db/map.js'
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
        /* enrichOne 内部自己 try/catch（失败返回 'failed'，不抛）——
           一条坏掉不该中断整趟：扫描的价值就在「把能补的都补掉」。 */
        const outcome = await enrichOne(row, log)
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
