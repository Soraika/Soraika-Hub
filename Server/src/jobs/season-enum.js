/**
 * 季度枚举 —— 用**排期页**一次性拿到全站 mikan id（比逐个 id 试快得多）
 * ---------------------------------------------------------------------------
 * 为什么这条路更快（实测数据）：
 *   · 逐 id 扫描：1..5400 每个都要发一次详情页请求，其中绝大多数是 404 空跑；
 *     4 并发也得十几分钟，而且空页比例越高越浪费。
 *   · 季度枚举：`GET /Home/BangumiCoverFlowByDayOfWeek?year=&seasonStr=` 一页就是**整季**
 *     的番剧条目（实测 2018 夏 108 条、2020 夏 73 条、2026 秋 85 条，每页 ~1 秒）。
 *     2014 春 → 2027 冬 一共 56 页 ≈ 1 分钟，就把「库里该有哪些 mikan_id」全拿到了。
 *
 * 两个来源的差别很重要，别混：
 *   · 季度页给的是 **mikan_id + 番名 + 星期**（排期身份）→ 写 `anime` 与 `mikan_bgm_map`
 *   · 详情页给的是 **bgm_id + 字幕组**（Bangumi 身份）→ 只能逐条问，见 jobs/enrich.js
 * 所以「枚举完」不等于「补完了」：枚举负责把 id 找齐，补全负责把 bgm_id 填上。
 *
 * Mikan 本身只保留到 2013 年左右（2012 及更早返回空壳页），所以起点定 2014；
 * 空季度不视为错误（有些季度确实抓不到），只记一笔继续下一页。
 */
import { fetchSeasonSchedule } from './../api/sources/mikan.js'
import { upsertManyFromMikan } from './../db/anime.js'
import { countMapAll, rememberMikan } from './../db/map.js'
import { getScanWatermark, maxScannedMikanId } from './../db/map.js'
import { logger } from './../lib/logger.js'

export const SEASONS = ['冬', '春', '夏', '秋']
/** Mikan 留存的起点（实测 2012 及更早是空壳页） */
export const EARLIEST_YEAR = 2014

/**
 * 枚举一段年份区间
 * @param {{ fromYear?: number, toYear?: number, trigger?: string, log?: object }} [options]
 */
export async function runSeasonEnum({ fromYear = EARLIEST_YEAR, toYear = new Date().getFullYear() + 1, log = logger } = {}) {
  const startedAt = Date.now()
  /* 注意：`upsertManyFromMikan` 内部**已经**调用了 rememberMikan，所以这里不能再靠它的返回值
     数「新增了多少个 id」（永远是 existing）。改成量总数差 —— 简单、准确、不用改下层签名。 */
  const mapBefore = countMapAll()
  const stat = {
    fromYear,
    toYear,
    pages: 0,
    emptyQuarters: 0,
    /** 拿到的「新」mikan_id 数（表里原来没有的） */
    newIds: 0,
    /** 见到的条目总数（含已存在的） */
    items: 0,
    maxMikanId: 0,
    failedQuarters: [],
    seconds: 0,
  }
  for (let year = fromYear; year <= toYear; year++) {
    for (const season of SEASONS) {
      stat.pages++
      let rows
      try {
        rows = await fetchSeasonSchedule(year, season)
      } catch (err) {
        stat.emptyQuarters++
        /* 空季度是常态（老季度被下架 / 未来季度还没上），不记为失败；只在日志留痕 */
        log.debug?.({ year, season, err: err?.message }, 'enum.season skip')
        continue
      }
      if (!rows?.length) {
        stat.emptyQuarters++
        continue
      }
      /* 写排期（首页按季就能看到这批数据）+ 登记身份（映射表的底账） */
      try {
        upsertManyFromMikan(rows)
      } catch (err) {
        stat.failedQuarters.push(`${year}${season}:${err?.message || 'write'}`)
        continue
      }
      for (const row of rows) {
        stat.items++
        const id = String(row.mikan_id || '').trim()
        if (!id) continue
        stat.maxMikanId = Math.max(stat.maxMikanId, Number(id) || 0)
        rememberMikan(id, row.title_mikan || null, null)
      }
      log.info({ year, season, rows: rows.length, newIds: stat.newIds }, 'enum.season ok')
      /* 页与页之间轻等一下：Mikan 对连续请求会限流 */
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  stat.newIds = countMapAll() - mapBefore
  stat.seconds = Math.round((Date.now() - startedAt) / 1000)
  log.info(stat, 'enum.done')
  return stat
}
