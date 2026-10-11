/**
 * 系列链补齐 —— 给「还没算过系列」的作品走一次链，把结果落库
 * ---------------------------------------------------------------------------
 * 触发时机（CONVENTIONS.md §10.1）：**新作品入库时算一次**；老系列不主动重算
 * （只有新季出现才会变，而新季一入库就会走这条链，顺带把老成员也归进同一个 series_id）。
 * 所以队列谓词就是「`series_checked_at IS NULL`」—— 谁没算过算谁。
 *
 * 一次处理：走链（1 跳，请求数 = 链长）→ 命中已有系列就**复用根名/风格（零 AI）** →
 * 否则调一次 AI（判 namingStyle / rootTitle / 番外归类）→ 把链上「已在库」的成员写进 `series_*`。
 *
 * 两个刻意的设计：
 *   · **AI 没配 / 失败 → 什么都不写**（含 `series_checked_at`）→ 下次自动重试；
 *     AI 没配时整轮直接退出（否则同一条会被反复捞起来空转）
 *   · 一轮之内用 `id < 游标` 前进 —— 失败的行本轮直接越过（它的 `series_checked_at` 仍是 NULL，
 *     下轮再来），不会卡在一条上死循环
 *
 * 用法：
 *   npm run series                 # 补到没有待算为止
 *   npm run series -- --limit=20   # 只补 20 条
 *   npm run series -- --force      # 全部重算（先把 series_checked_at 清空）
 */
import { pathToFileURL } from 'node:url'
import { classifySeries } from '../api/pages/ai.js'
import { loadStoredSettings } from '../api/pages/settings.js'
import { fetchRelatedSubjects } from '../api/sources/bgm.js'
import { config } from '../config.js'
import { db, val } from '../db/index.js'
import { findByBgmIds, setSeriesMeta } from '../db/anime.js'
import { logger } from '../lib/logger.js'
import { pickRepresentative, walkSeries } from '../lib/series.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const stmt = {
  next: db.prepare(`
    SELECT * FROM anime
    WHERE bgm_id IS NOT NULL AND series_checked_at IS NULL AND id < ?
    ORDER BY id DESC LIMIT 1
  `),
  /** 批量取（并发跑时用）：一次领 N 条，领完就推进游标 —— 不会重复处理同一条 */
  batch: db.prepare(`
    SELECT * FROM anime
    WHERE bgm_id IS NOT NULL AND series_checked_at IS NULL AND id < ?
    ORDER BY id DESC LIMIT ?
  `),
  count: db.prepare('SELECT COUNT(*) AS n FROM anime WHERE bgm_id IS NOT NULL AND series_checked_at IS NULL'),
  clearChecked: db.prepare('UPDATE anime SET series_checked_at = NULL'),
  /**
   * 认领（CAS）：只有还是 NULL 才算抢到 —— 与 worker / 另一个回填进程互斥。
   * 值用 -1（哨兵 = 处理中）而不是另开一列：谓词是 `IS NULL`，-1 天然进不了队列，
   * 且负的时间戳不可能出现。语义与 db/queue.js 的触发③完全一致。
   */
  claim: db.prepare('UPDATE anime SET series_checked_at = -1 WHERE id = ? AND series_checked_at IS NULL'),
  /** 放回队列（这次没算成）：-1 → NULL，否则它会永远卡在"处理中" */
  release: db.prepare('UPDATE anime SET series_checked_at = NULL WHERE id = ? AND series_checked_at = -1'),
}

/**
 * 给一条作品补齐系列信息
 * ---------------------------------------------------------------------------
 * **任何异常都不许抛出去**：worker 的调度循环靠这里返回 `'skipped'` 来决定"放回队列、下轮再来"。
 * 上游 404 / 超时 / 写库失败一旦抛穿，死的不只是这一条，而是整个守护进程（冒烟测踩到过）。
 * @param {object} row anime 行（需要 id / bgm_id）
 * @returns {Promise<'done'|'skipped'|'ai-disabled'|'no-bgm'>} `'skipped'` = 这次没算成、**什么都没写** → 下轮重试
 */
export async function fillSeriesFor(row, { log = logger } = {}) {
  if (!row?.bgm_id) return 'no-bgm'
  try {
    return await fillSeriesOnce(row, { log })
  } catch (err) {
    // 统一的兜底：什么都不写（含 series_checked_at）→ 留在待算里，下轮自动重试
    log.warn(
      { id: row?.id, bgmId: row?.bgm_id, code: err?.code, status: err?.detail?.status, err: err?.message },
      'series.fill fail',
    )
    return 'skipped'
  }
}

/** 真正干活的那趟（异常由上面的 fillSeriesFor 兜） */
async function fillSeriesOnce(row, { log = logger } = {}) {
  const startedAt = Date.now()
  const startId = String(row.bgm_id)

  /* ① 走链：正传链 + 番外（一遍遍历，番外零额外请求） */
  const { chain, extras, orphans, truncated } = await walkSeries({
    startBgmId: startId,
    loadRelated: fetchRelatedSubjects,
    log,
  })
  if (!chain.length || truncated) {
    log.warn({ id: row.id, bgmId: startId, chain: chain.length, extras: extras.length, orphans, truncated }, 'series.walk odd')
  }

  /* ② 链上/番外里「已经在库」的成员 —— 代表行从这里选（链上最靠前的那个） */
  const libRows = findByBgmIds([...chain.map((n) => n.id), ...extras.map((e) => e.id)])
  const libMap = new Map(libRows.map((r) => [String(r.bgm_id), r]))
  const rep = pickRepresentative(chain, libMap)
  const repRow = rep ? libMap.get(rep.id) : null
  const seriesId = repRow?.series_id || repRow?.id || row.id

  /* ③ 已有系列的根名/风格就直接复用（新季出现时**零 AI 调用**）；缺了才问 AI */
  let ai = { namingStyle: null, rootTitle: '', extras: [] }
  if (!repRow?.naming_style || !repRow?.series_root_title) {
    try {
      ai = await classifySeries({ chain, extras, log })
    } catch (err) {
      if (err?.code === 'AI_DISABLED') return 'ai-disabled'
      log.warn({ id: row.id, bgmId: startId, err: err.message }, 'series.ai fail')
      return 'skipped' // 什么都不写 → 下次重试
    }
  }

  /* ④ 落库（setSeriesMeta 是 COALESCE 语义：传 null 不会抹掉已有值） */
  const now = Date.now()
  const extraRelation = new Map(ai.extras.map((e) => [e.bgmId, e.relation]))
  const conflicts = []
  /**
   * 写一个成员：**首写优先** —— 这行已经归属别的系列时不抢。
   * 两个系列之间偶尔会有同一行（番外 / 剧场版 被两边都挂着）：谁先算出来算谁的，
   * 否则后算的会把对方的 `series_id` / `series_index` 覆盖成混合状态（实测踩过：
   * 混出「两个 index=1」的系列）。这里只记录冲突，不报错 —— 属于可接受的数据现实。
   */
  const writeMember = (libRow, meta) => {
    if (libRow.series_id && String(libRow.series_id) !== String(seriesId)) {
      conflicts.push({ id: libRow.id, kept: libRow.series_id, wanted: seriesId })
      return
    }
    setSeriesMeta(libRow.id, { seriesId, ...meta })
  }

  for (const node of chain) {
    const libRow = libMap.get(node.id)
    if (!libRow) continue
    writeMember(libRow, {
      seriesIndex: node.index,
      seriesRelation: node.index === 1 ? null : '续集', // 链头没有「相对前驱」的关系
      seriesCheckedAt: now,
    })
  }
  for (const item of extras) {
    const libRow = libMap.get(item.id)
    if (!libRow) continue
    writeMember(libRow, { seriesRelation: extraRelation.get(item.id) || '其他', seriesCheckedAt: now })
  }
  // 根名兜底：AI 对「单部作品（链上只有它自己）」经常返回空 rootTitle ——
  // 这时用作品自己的展示名（title_cn 优先），总比顶层目录叫「未归类」强。
  // 注意：日志里报的必须是**最终落库的那个值**，否则会看到「日志说空、库里其实有」的假象。
  const rootName = ai.rootTitle || repRow?.series_root_title || repRow?.title_cn || repRow?.title || ''
  if (repRow) {
    writeMember(repRow, {
      namingStyle: ai.namingStyle || repRow.naming_style,
      seriesRootTitle: rootName,
      seriesCheckedAt: now,
    })
  }

  log.info(
    {
      id: row.id,
      bgmId: startId,
      seriesId,
      representative: rep?.id ?? null,
      chain: chain.length,
      extras: extras.length,
      inLibrary: libMap.size,
      namingStyle: ai.namingStyle || repRow?.naming_style || null,
      rootTitle: rootName,
      ...(conflicts.length ? { conflicts } : {}),
      ms: Date.now() - startedAt,
    },
    'series.fill ok',
  )
  return 'done'
}

/**
 * 补一批（limit <= 0 = 一直补到没有待算）
 * @param {{ limit?:number, gapMs?:number, conc?:number, force?:boolean, log?:object }} [options]
 *   `conc`：并发条数。首轮全量补齐有几千条，串行太慢 → 并发 4~8（瓶颈是 AI 的响应时间）。
 *           **只影响速度，不影响正确性**：每条都先 CAS 认领（`series_checked_at` 置 -1）再处理，
 *           所以多个回填进程 / worker 同时跑也不会重复走链、重复花 AI 的钱。
 *   算出结果 → `series_checked_at` 写成真实时间（出队）；没算成 → 放回 NULL（下轮重试）。
 */
export async function runSeries({ limit = 0, gapMs, conc = 1, force = false, log = logger } = {}) {
  if (!config.ai.enabled) {
    // 没配 AI 就整轮退出：写入要 AI 成功才发生，否则同一条会被反复捞起来空转
    log.warn({ pending: stmt.count.get().n }, 'series.skip ai-disabled')
    return { aiDisabled: true, processed: 0, done: 0, skipped: 0, pending: stmt.count.get().n }
  }
  if (force) {
    const cleared = stmt.clearChecked.run().changes
    log.info({ cleared }, 'series.force clear-checked')
  }

  const gap = Number.isFinite(Number(gapMs)) ? Number(gapMs) : config.worker.gapMs
  const window = Math.max(1, Number(conc) || 1)
  const result = { aiDisabled: false, conc: window, processed: 0, done: 0, skipped: 0, pending: stmt.count.get().n }
  let cursorId = Number.MAX_SAFE_INTEGER
  const rest = Number(limit) > 0 ? Number(limit) : Infinity

  while (result.processed < rest) {
    const candidates = window === 1 ? [stmt.next.get(cursorId)].filter(Boolean) : stmt.batch.all(cursorId, window)
    if (!candidates.length) break
    cursorId = candidates[candidates.length - 1].id // 本轮只前进、不回头（失败的下轮再来）

    // 认领（CAS）：抢不到说明别的进程（worker / 另一个回填）正在处理它 → 跳过。
    // 游标已经越过它，所以不会在这里打转。这一步让「多进程同时跑」不重复走链、不重复花 AI 钱。
    const rows = candidates.filter((row) => stmt.claim.run(val(row.id)).changes === 1)
    if (!rows.length) continue

    const pairs = await Promise.all(
      rows.map(async (row) => ({ row, outcome: await fillSeriesFor(row, { log }) })),
    )
    for (const { row, outcome } of pairs) {
      result.processed++
      if (outcome === 'done') {
        result.done++ // fillSeriesFor 已把 series_checked_at 写成真实时间，出了队列
        continue
      }
      if (outcome === 'ai-disabled') result.aiDisabled = true
      result.skipped++
      stmt.release.run(val(row.id)) // 没算成就放回，否则这条会一直卡在"处理中"没人管
    }
    if (result.aiDisabled) break
    if (result.processed % 50 === 0) {
      result.pending = stmt.count.get().n
      log.info({ ...result }, 'series.progress')
    }
    await sleep(gap)
  }

  result.pending = stmt.count.get().n
  log.info(result, 'series.run done')
  return result
}

/* ── CLI（npm run series）────────────────────────────────────────────────── */
const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isCli) {
  const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
  const counts = () => ({
    done: db.prepare('SELECT COUNT(*) AS n FROM anime WHERE series_checked_at IS NOT NULL').get().n,
    pending: stmt.count.get().n,
  })

  // 独立进程也要吃设置页里的覆盖项（AI key 可能填在设置页而不是 .env）
  const overridden = loadStoredSettings()

  if (process.argv.includes('--status')) {
    // 只看进度、不干活（回填在后台跑时用它看进度，纯读）
    logger.info({ ...counts(), aiEnabled: config.ai.enabled, settingsOverridden: overridden }, 'cli.series status')
  } else {
    logger.info({ ...counts(), aiEnabled: config.ai.enabled, settingsOverridden: overridden }, 'cli.series start')
    await runSeries({
      limit: arg('limit', 0),
      gapMs: arg('gap'),
      conc: arg('conc', 1),
      force: process.argv.includes('--force'),
    })
  }
}
