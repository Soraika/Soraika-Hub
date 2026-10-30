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
import { ensureBgmStub, findByBgmIds, listSeriesMembers, resetSeriesPositions, setSeriesMeta, setSeriesPosition } from '../db/anime.js'
import { logger } from '../lib/logger.js'
import { pickRepresentative, walkSeries } from '../lib/series.js'
import { SEASON_START_MONTH } from '../lib/season.js'

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
 * 给「链上确实存在、但库里没有」的正传成员建骨架行
 * ---------------------------------------------------------------------------
 * 场景：《死神 千年血战篇》的上游 `前传` 是 2004 年的《BLEACH》。
 * Mikan 的季度页对 2004 年返回空壳（扫不到），所以库里没有那一行 →
 * 只写「已在库」的成员时，季位就从 S02 开始（用户看到「没有 S1」）。
 * 实测 494 个多成员系列里有 **160 个**属于这种情况。
 *
 * 只补正传链（番外是剧场版/OVA，缺了不影响季位）；单趟最多 20 个，
 * 万一关系成网也不会一次灌进几百行。新行 `series_checked_at` 已置为当前时间，
 * 所以不会再排一次「自己走链」的队。
 * @returns {Array<{id:number,bgmId:string}>} 本次新建的行
 */
const MAX_STUBS_PER_WALK = 20
function ensureChainStubs(chain, libMap, { log } = {}) {
  const created = []
  for (const node of chain) {
    if (libMap.has(node.id)) continue
    if (created.length >= MAX_STUBS_PER_WALK) {
      log?.warn?.({ bgmId: node.id, cap: MAX_STUBS_PER_WALK }, 'series.stub cap')
      continue
    }
    const stub = ensureBgmStub({
      bgmId: node.id,
      title: node.nameCn || node.name || null,
      titleCn: node.nameCn || null,
    })
    if (!stub) continue
    libMap.set(node.id, stub)
    created.push({ id: stub.id, bgmId: node.id, title: stub.title })
  }
  if (created.length) log?.info?.({ count: created.length, sample: created.slice(0, 5) }, 'series.stub create')
  return created
}

/**
 * 「全剧场版系列」按**整条系列**重排季位（不是只排本次走链看到的那些）
 * ---------------------------------------------------------------------------
 * 为什么必须按整条系列排：某部剧场版可能是**别的走链**写进来的（它自己那趟只看到自己附近的两三部），
 * 那趟写完后 `series_index` 是 NULL，本次走链即使知道 allMovies 也覆盖不到它 ——
 * 实测《哆啦A梦：新・大雄的海底鬼岩城》就卡在 index=NULL（其余 33 部都是 1..33）。
 *
 * 排序键：`air_date`（YYYY-MM）→ 退到「年 + 季」→ 都没有的排最后，同键按 bgm_id 升序。
 * 这个排序是**确定性的**：两个进程同时重排得到的顺序一致，所以不怕并发。
 */
export function renumberMovieSeries(seriesId, { log = logger } = {}) {
  const rows = listSeriesMembers(seriesId)
  if (rows.length < 2) return 0
  const rank = (r) => {
    const d = String(r.air_date || '')
    if (/^\d{4}-\d{2}/.test(d)) return Number(d.slice(0, 4)) * 100 + Number(d.slice(5, 7))
    const y = Number(r.year)
    if (!y) return Number.MAX_SAFE_INTEGER
    return y * 100 + (SEASON_START_MONTH[r.season] ?? 1)
  }
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b) || Number(a.bgm_id || 0) - Number(b.bgm_id || 0))
  const now = Date.now()
  let written = 0
  // 整段重排放一个事务里：中间状态（全 NULL）不能被并发的另一趟走链看到，否则两趟交叉写会乱
  db.exec('BEGIN IMMEDIATE')
  try {
    resetSeriesPositions(seriesId) // 先清：季位上有部分唯一索引
    for (const [i, r] of sorted.entries()) {
      setSeriesPosition(r.id, { seriesIndex: i + 1, seriesRelation: '剧场版', seriesCheckedAt: now })
      written++
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    log?.warn?.({ seriesId, err: err.message }, 'series.renumber fail')
    return 0
  }
  log?.info?.({ seriesId, count: sorted.length, written }, 'series.renumber movies')
  return written
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

  /* ②b 链上「缺的环节」补骨架行 —— 否则季位整体前移（最典型：S01 不见了）
     只补**正传链**（番外是剧场版/OVA，缺了不影响季位）；单趟最多补 20 个，防关系成网时跑飞。 */
  const stubs = ensureChainStubs(chain, libMap, { log })

  const rep = pickRepresentative(chain, libMap)
  const repRow = rep ? libMap.get(rep.id) : null
  const seriesId = repRow?.series_id || repRow?.id || row.id

  /* ③ 根名/风格：随便哪个成员身上有就复用（**零 AI 调用**）；一个都没有才问 AI。
     不能只看代表行 —— 补了骨架行之后代表行会变成新行，它身上没有根名。 */
  const rootRow =
    [repRow, ...libMap.values()].find((r) => r?.series_root_title && r?.naming_style) ??
    [repRow, ...libMap.values()].find((r) => r?.series_root_title) ??
    null
  let ai = { namingStyle: null, rootTitle: '', extras: [] }
  if (!rootRow?.naming_style || !rootRow?.series_root_title) {
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
  const writeMember = (libRow, meta, { position = false } = {}) => {
    if (libRow.series_id && String(libRow.series_id) !== String(seriesId)) {
      conflicts.push({ id: libRow.id, kept: libRow.series_id, wanted: seriesId })
      return
    }
    // 正传链位 / 番外类别 → **覆盖**写（重排季位要生效）；根名等 → COALESCE 写（不抹掉已有值）
    try {
      if (position) setSeriesPosition(libRow.id, { seriesId, ...meta })
      else setSeriesMeta(libRow.id, { seriesId, ...meta })
    } catch (err) {
      // 季位上有部分唯一索引：两个进程同时算同一系列时，晚到的那个会撞索引。
      // 这不是错误，只说明「别人已经占了这个季位」→ 放弃这次写入（不重试、不污染数据）。
      conflicts.push({ id: libRow.id, reason: 'position-unique', err: err.message })
    }
  }

  // 季位按「本次真正能写的成员」连续编号 —— 不直接用走链给的序号。三个原因：
  //   · 补骨架行有单趟上限（超上限的节点建不出来）→ 用链序号会留空洞（实测蜡笔小新剧场版 24/33）
  //   · 链头本身是剧场版（被降级、不给季位）时，后面的正传不该从 2 开始（实测《弦音》）
  //   · **整条系列都是剧场版**时（AI 判 allMovies：哆啦A梦剧场版 31 部），番外也按年排进季位，
  //     否则一半是 S01..S25、另一半全是「番外」，看着就是坏的
  const movieOnly = ai.allMovies === true || Number(rootRow?.series_all_movies) === 1
  /** 排序键：air_date（YYYY-MM）优先，退到 年+季；都没有的排最后 */
  const dateRank = (row) => {
    const d = String(row?.air_date || '')
    if (/^\d{4}-\d{2}/.test(d)) return Number(d.slice(0, 4)) * 100 + Number(d.slice(5, 7))
    const y = Number(row?.year)
    if (!y) return Number.MAX_SAFE_INTEGER
    return y * 100 + (SEASON_START_MONTH[row?.season] ?? 1)
  }
  const positions = new Map()
  let seq = 0
  for (const node of chain) {
    if (!libMap.has(node.id)) continue // 没写进库（超上限 / 写库失败）→ 不占季位
    if (node.demoted) continue
    positions.set(node.id, ++seq)
  }
  if (movieOnly) {
    const rest = extras
      .filter((e) => libMap.has(e.id) && !positions.has(e.id))
      .sort((a, b) => dateRank(libMap.get(a.id)) - dateRank(libMap.get(b.id)))
    for (const e of rest) positions.set(e.id, ++seq)
  }
  /**
   * 同一系列可能被**多条不同的链**写到（BGM 的关系是局部的：《我的英雄学院》剧场版之间互连、
   * TV 之间互连，两条链的「第 1 个」不是同一行）。所以季位一律**只填不改**（COALESCE）：
   * 谁先算出来算谁的，后来的只补空字段 —— 永不产生「两个 index=1」。
   * 需要整体重排时（链上补进了新的头部）走一次性修复：清空该系列的系列字段让它重算，
   * 第一趟走链会把季位一次性写对。
   */
  for (const node of chain) {
    const libRow = libMap.get(node.id)
    if (!libRow) continue
    const position = node.demoted ? null : (positions.get(node.id) ?? null)
    writeMember(
      libRow,
      // 起点自己是剧场版/OVA（用户直接点开的）→ 不给季位，按番外类别写
      node.demoted || position == null
        ? { seriesRelation: node.demoted || libRow.series_relation || '续集', seriesCheckedAt: now }
        : {
            seriesIndex: position,
            seriesRelation: position === 1 ? null : '续集', // 链头没有「相对前驱」的关系
            seriesCheckedAt: now,
          },
    )
  }
  for (const item of extras) {
    const libRow = libMap.get(item.id)
    if (!libRow) continue
    const position = positions.get(item.id) ?? null
    writeMember(
      libRow,
      {
        // 番外默认不给季位（清掉可能存在的旧值）；「全剧场版系列」例外：按年排进季位
        seriesIndex: movieOnly ? position : null,
        seriesRelation:
          (movieOnly ? '剧场版' : null) || item.category || extraRelation.get(item.id) || '其他',
        seriesCheckedAt: now,
      },
      { position: true },
    )
  }
  // 根名兜底：AI 对「单部作品（链上只有它自己）」经常返回空 rootTitle ——
  // 这时用作品自己的展示名（title_cn 优先），总比顶层目录叫「未归类」强。
  // 注意：日志里报的必须是**最终落库的那个值**，否则会看到「日志说空、库里其实有」的假象。
  const rootName = ai.rootTitle || rootRow?.series_root_title || repRow?.title_cn || repRow?.title || ''
  if (repRow) {
    writeMember(repRow, {
      // 全剧场版系列强制 volume：归档目录是「哆啦A梦剧场版/01 大雄的恐龙」，不是 S01
      namingStyle: movieOnly ? 'volume' : ai.namingStyle || rootRow?.naming_style,
      seriesRootTitle: rootName,
      // AI 判过的「全是剧场版」要落库：后续走链会因「根名已有」跳过 AI，判据不能丢
      seriesAllMovies: ai.allMovies === true ? 1 : null,
      seriesCheckedAt: now,
    })
  }
  // 全剧场版系列：按**整条系列**重排（本次走链没看到的成员也要归位，见函数注释）
  if (movieOnly) renumberMovieSeries(seriesId, { log })

  log.info(
    {
      id: row.id,
      bgmId: startId,
      seriesId,
      representative: rep?.id ?? null,
      chain: chain.length,
      extras: extras.length,
      inLibrary: libMap.size,
      stubs: stubs.length,
      movieOnly,
      namingStyle: movieOnly ? 'volume' : ai.namingStyle || rootRow?.naming_style || null,
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
