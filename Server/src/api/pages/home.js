/**
 * 首页聚合层 —— 页面只拿到「可以直接摆」的数据（成品字符串、已分组、已排序）
 * ---------------------------------------------------------------------------
 * 策略：**数据库优先**（定好的）
 *   1. 该季库里有数据且未过期（CACHE_TTL_MS）→ 直接返回，不打上游
 *   2. 否则抓 Mikan 季度页（1 次请求，排期主源）→ 落库 → 再读库返回
 *   3. 评分由**后台守护进程**负责（jobs/worker.js）：它逐条走
 *      「mikanId → bgmId（权威）→ Bangumi 评分」并回写；补进去的评分下次请求就能看到。
 *      首页请求路径里**不做任何评分补齐**（不阻塞、也不用猜测式标题匹配）
 */
import { warmPosters } from './../../cache/poster.js'
import { config } from './../../config.js'
import { listBySeason, maxUpdatedAt, upsertManyFromMikan } from './../../db/anime.js'
import { logger } from './../../lib/logger.js'
import { buildYearOptions, currentSeason } from './../../domain/season.js'
import { groupByDay } from './../mappers/home.js'
import { fetchSeasonSchedule } from './../sources/mikan.js'

/**
 * 首页排期
 * @param {{ year?: string|number, season?: string, force?: boolean, log?: object }} [params]
 */
export async function getHomeSchedule({ year, season, force = false, log = logger } = {}) {
  const startedAt = Date.now()
  const now = new Date()
  const fallback = currentSeason(now)
  const target = { year: Number(year) || fallback.year, season: season || fallback.season }

  const cachedRows = listBySeason(target.year, target.season)
  const fresh =
    cachedRows.length > 0 && Date.now() - maxUpdatedAt(target.year, target.season) < config.cacheTtlMs

  let rows = cachedRows
  let source = 'db'
  let refreshed = false

  if (force || !fresh) {
    const incoming = await fetchSeasonSchedule(target.year, target.season)
    upsertManyFromMikan(incoming)
    source = 'mikan'
    refreshed = true
    rows = listBySeason(target.year, target.season)
    // 评分/字幕组由后台守护进程逐条补齐（jobs/worker.js），这里不等它
  }

  // 库里没图源的行：后台把封面 / 本地缓存补上（前端拿到的仍是直链，不用等）——
  // 第一次点开就有图，第二次这条就已经是本地缓存了（见 cache/poster.js）
  warmPosters(rows)

  // debug 级别：带上 requestId（请求路径传的是 req.log），排「某个请求为什么慢」时很有用
  log.debug(
    { year: target.year, season: target.season, source, cached: source === 'db', total: rows.length, ms: Date.now() - startedAt },
    'home.schedule ok',
  )

  return {
    season: { ...target, label: `${target.year} ${target.season}` },
    years: buildYearOptions({ now }),
    days: groupByDay(rows),
    meta: {
      /** 'db' = 本次响应直接读库（没回源）；'mikan' = 本次回源刷新过 */
      source,
      /** 本次是否走了缓存（等价于 source === 'db'，留着方便前端/排错直接看） */
      cached: source === 'db',
      /** 是否回源刷新过 */
      refreshed,
      total: rows.length,
    },
  }
}
