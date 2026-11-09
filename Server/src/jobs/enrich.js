/**
 * 档案补齐（后台任务库）—— 逐条把每部作品的**完整档案**补齐并落库
 * ---------------------------------------------------------------------------
 * 一条作品补齐的东西：
 *   · 没有 bgmId 的 → Mikan 详情页 1 次（权威 bgmId + 字幕组列表）+ Bangumi 条目 1 次
 *   · **已经有 bgmId 的 → 只打 Bangumi 1 次**（评分/标签/简介都在那，不必再问 Mikan）
 *
 * 为什么只能逐条：这两个接口都是「按 id 单个查」，没有批量版 —— 所以必须
 *   · 节流（gapMs，别打爆上游）
 *   · 认领式取任务（claimNextMissingBgm / claimNextArchive 都用 CAS 抢占）
 *   · 可重入（处理过的排到队尾，失败的下轮还会轮到）
 *
 * 用法：
 *   npm run enrich                 # 手动补齐到没有待补为止（两条队列都消费）
 *   npm run enrich -- --limit=20   # 只补 20 条
 *   npm run enrich -- --gap=200    # 调每条之间的间隔
 */
import { pathToFileURL } from 'node:url'
import { fetchSubject } from '../api/sources/bgm.js'
import { fetchAnimeProfile } from '../api/sources/mikan.js'
import { config } from '../config.js'
import { applyBgmMeta, findByMikanId, isMovieOnlySeries, rememberSubgroups, stats } from '../db/anime.js'
import { markMapChecked } from '../db/map.js'
import { renumberMovieSeries } from './series.js'
import {
  claimNextArchive,
  claimNextMissingBgm,
  countGaveUp,
  countMissingBgm,
  markBgmChecked,
  markBgmMiss,
  takeNextStale,
} from '../db/queue.js'
import { bgmToRow } from '../lib/format.js'
import { logger } from '../lib/logger.js'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 补齐一条作品的档案
 * ---------------------------------------------------------------------------
 * 两条入口，都汇聚到 `applySubject`：
 *   · **已经有 `bgm_id`**（扫描进来的行就是这样）→ 直接取 Bangumi 条目。
 *     档案（评分/标签/简介）本来就只来自 Bangumi，而 id 已经有了 —— 少打一次上游，
 *     也不要求这些行有 `mikan_id`（纯 Bangumi 的行照样能补）。
 *   · 没有 `bgm_id` → 先走 Mikan 详情页拿权威 id（顺带落字幕组），再取 Bangumi。
 * @param {object} row anime 行（需要 id / title / year / season；有条目时用 row.bgm_id）
 * @returns {Promise<'enriched'|'noBgmId'|'failed'>}
 */
export async function enrichOne(row, log = logger) {
  const startedAt = Date.now()
  try {
    if (row.bgm_id) {
      // ①b 的另一半：顺手抓一次 Mikan 详情页，把「这部作品有哪些字幕组」记进名字字典。
      // 为什么必须在这里补：这条快路径**跳过了 Mikan**（省一次请求），而字幕组只存在于
      // Mikan 详情页 —— 不补的话，扫描进来的老番点开面板「资源」区永远是空的。
      // 默认开，可在设置页关掉（`worker.fetchSubgroups`）；失败只 warn，不影响档案补齐。
      if (config.worker.fetchSubgroups && row.mikan_id) await rememberSubgroupsByMikan(row, log)
      return await applySubject(row.bgm_id, row, log, startedAt)
    }

    // ① Mikan 详情页：权威 bgmId + 字幕组列表
    let profile
    try {
      profile = await fetchAnimeProfile(row.mikan_id)
    } catch (err) {
      // Mikan 明确 404（这个 mikanId 的页面根本不存在）→ **上游确实没有**，按"放弃"处理：
      // 记一次尝试时间（映射表），30 天后才再试 —— 否则队列会为它每分钟白打一次上游。
      if (/HTTP 404/.test(String(err?.message || '')) || err?.detail?.status === 404) {
        markBgmMiss(row.mikan_id)
        log.warn({ mikanId: row.mikan_id, status: 404 }, 'worker.enrich mikan-not-found')
        return 'noBgmId'
      }
      throw err
    }
    rememberSubgroups(profile.subgroups) // 顺手记进名字字典（不再存「哪个作品有它」）

    if (!profile.bangumiId) {
      // Mikan 详情页没挂 Bangumi 链接 —— 记一次尝试时间，30 天后自动再试
      markBgmMiss(row.mikan_id)
      log.warn(
        { mikanId: row.mikan_id, subgroups: profile.subgroups.length },
        'worker.enrich no-bgm-link',
      )
      return 'noBgmId'
    }

    // 身份确认成功：**先落映射表**（这是不可重建的数据），再补档案
    markMapChecked(row.mikan_id, profile.bangumiId)

    // ② Bangumi 条目：评分 / 人数 / 标签 / 简介 / 话数 / 放送日
    return await applySubject(profile.bangumiId, row, log, startedAt)
  } catch (err) {
    log.warn({ id: row.id, mikanId: row.mikan_id, err: err.message, ms: Date.now() - startedAt }, 'worker.enrich fail')
    return 'failed'
  }
}

/**
 * 顺手把这部作品的字幕组记进**名字字典**（Mikan 详情页）
 * ---------------------------------------------------------------------------
 * 只做「记字典」这一件事：`anime_subgroup` 那张关系表已经不存了，
 * 面板打开时 `/subgroups` 会现取「组 + 各自的 rss id」。这里补的是**组名**，
 * 失败只 warn —— 字幕组抓不到不该让档案补齐失败（评分/标签更重要）。
 */
async function rememberSubgroupsByMikan(row, log) {
  try {
    const profile = await fetchAnimeProfile(row.mikan_id)
    if (profile.subgroups?.length) rememberSubgroups(profile.subgroups)
  } catch (err) {
    log.warn({ id: row.id, mikanId: row.mikan_id, err: err.message }, 'worker.enrich subgroups fail')
  }
}

/** 取 Bangumi 条目并落档案（评分 / 人数 / 标签 / 简介 / 话数 / 放送日） */
async function applySubject(bgmId, row, log, startedAt) {
  let subject
  try {
    subject = await fetchSubject(bgmId)
  } catch (err) {
    // 上游明确说「没这个条目」（404）→ 这个 bgmId 是坏的，同样计数放弃；
    // 网络抖动 / 5xx 不计数，留给下轮正常重试
    const status = err?.detail?.status
    if (status === 404 || err?.code === 'BAD_REQUEST') {
      markBgmMiss(row.mikan_id)
      log.warn({ mikanId: row.mikan_id, bgmId, status }, 'worker.enrich bgm-not-found')
      return 'noBgmId'
    }
    throw err
  }

  applyBgmMeta(
    bgmToRow(subject, {
      mikan_id: row.mikan_id,
      title: row.title ?? row.title_mikan,
      year: row.year,
      season: row.season,
    }),
  )
  // ①a 来的行是映射表的（没有 anime 主键）—— 档案写完就按 mikan_id 找回 anime 行；
  // ①b 来的行本身就有 id。两条路都需要把 `bgm_checked_at` 刷新，避免马上又被刷一次。
  const animeId = row.id ?? findByMikanId(row.mikan_id)?.id ?? null
  if (animeId) markBgmChecked(animeId)
  // 刚补到 air_date 的行如果属于「全剧场版系列」→ 重排一次（按上映日期）
  const movieSeriesId = animeId ? isMovieOnlySeries(animeId) : null
  if (movieSeriesId) {
    try {
      await renumberMovieSeries(movieSeriesId, { log })
    } catch (err) {
      log.warn({ id: animeId, seriesId: movieSeriesId, err: err.message }, 'worker.enrich renumber fail')
    }
  }

  log.info(
    {
      id: animeId,
      mikanId: row.mikan_id,
      bgmId,
      score: subject?.rating?.score ?? null,
      ratingTotal: subject?.rating?.total ?? 0,
      ms: Date.now() - startedAt,
    },
    'worker.enrich ok',
  )
  return 'enriched'
}

/**
 * 补齐一批 / 全部（limit <= 0 表示一直补到队列空）
 * ---------------------------------------------------------------------------
 * **两条队列一起消费**，顺序即优先级：
 *   ① 没有 bgmId 的（新番，用户正在看）→ ② 有 bgmId 但缺档案的（扫描进来的老番，占八成）
 * @param {{ limit?: number, gapMs?: number, log?: object }} [options]
 */
export async function runEnrich({ limit = 0, gapMs, log = logger } = {}) {
  const gap = Number.isFinite(Number(gapMs)) ? Number(gapMs) : config.worker.gapMs
  const before = stats()
  const result = { scanned: 0, enriched: 0, noBgmId: 0, failed: 0, before, after: null }

  let rest = Number(limit) > 0 ? Number(limit) : Infinity
  for (let i = 0; i < rest; i++) {
    const row = claimNextMissingBgm() ?? claimNextArchive()
    if (!row) break

    const outcome = await enrichOne(row, log)
    result.scanned++
    if (outcome === 'enriched') result.enriched++
    else if (outcome === 'noBgmId') result.noBgmId++
    else result.failed++

    await sleep(gap)
  }

  result.after = stats()
  return result
}

/**
 * 今天（或昨天，如果今天还没到点）的「每日更新时刻」时间戳
 * ---------------------------------------------------------------------------
 * 固定时刻语义的关键：分界线不是一个「滚动 24 小时」，而是**最近一次到点的时刻**。
 *   · 现在 08:00，dailyAt=04:00 → 分界 今天 04:00 → 之后刷过的都不再算过期
 *   · 现在 02:00，dailyAt=04:00 → 分界 昨天 04:00 → 今天还没到点，不会重复刷
 * 好处：不依赖进程内状态 —— worker 中途重启，重新算一下分界线就能接着把没刷完的刷完。
 */
export function lastDailyBoundary(now = new Date(), dailyAt = config.worker.dailyAt) {
  const [hour, minute] = String(dailyAt).split(':').map((v) => Number(v) || 0)
  const boundary = new Date(now)
  boundary.setHours(hour, minute, 0, 0)
  if (boundary.getTime() > now.getTime()) boundary.setDate(boundary.getDate() - 1)
  return boundary.getTime()
}

/**
 * 每日更新一步：把「今年的番」里、上次刷新早于「最近一次到点时刻」的一条重刷一遍整份档案
 * （bgmid + 字幕组 + 评分/评分人数/标签/简介/集数 —— 正在放送的番每天都可能变）
 * 复用 enrichOne，所以两个触发做的事完全一致，只是队列不同。
 * @returns {Promise<boolean>} 是否处理了一条（false = 到点后该刷的都刷完了）
 */
export async function refreshStaleOne({ log = logger } = {}) {
  const year = config.worker.staleYear || new Date().getFullYear()
  const olderThan = lastDailyBoundary()
  const row = takeNextStale({ year, olderThan })
  if (!row) return false

  await enrichOne(row, log)
  return true
}

// ── 直接执行时作为 CLI 运行（npm run enrich）───────────────────────────────
const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isCli) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
  logger.info({ pending: countMissingBgm(), gaveUp: countGaveUp() }, 'cli.enrich start')
  const result = await runEnrich({ limit: arg('limit'), gapMs: arg('gap') })
  logger.info(
    {
      scanned: result.scanned,
      enriched: result.enriched,
      noBgmId: result.noBgmId,
      failed: result.failed,
      pending: countMissingBgm(),
      gaveUp: countGaveUp(),
    },
    'cli.enrich done',
  )
}
