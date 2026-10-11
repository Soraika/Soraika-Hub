/**
 * Mikan 数据源 —— **排期主源**（首页的星期/番名/封面/mikanId 都从这来）
 * ---------------------------------------------------------------------------
 * 为什么它是主源：Mikan 季度页一次请求就给全「星期 + 番名 + mikanId + 封面」，
 * 而且 dayofweek 天然是 0=周日…6=周六、7=剧场版、8=OVA（与前端 weekOrder.js 一致，零转换）。
 * Bangumi 只负责评分/标签（见 sources/bgm.js）。
 *
 * 抓取实现复用 clients/Mikan.js（已写好：请求 + 重试 + cheerio 解析）。
 */
import {
  getAnimeBangumiId,
  getAnimeDetailPage,
  getAnimeRSSPage,
  getAnimeReleaseFromRSS,
  getMikanSeasonPage,
  getSeasonAnimeList,
  getSubGroupList,
} from '../../clients/Mikan.js'
import { config } from '../../config.js'
import { fail } from '../../lib/errors.js'
import { mikanToRow, releaseToItem } from '../../lib/format.js'

/**
 * 抓某季排期 → anime 行数组
 * @param {number|string} year
 * @param {string} season 春 / 夏 / 秋 / 冬
 */
export async function fetchSeasonSchedule(year, season) {
  const html = await getMikanSeasonPage(config.mikan.base, year, season)
  const list = getSeasonAnimeList(html)

  if (!Array.isArray(list) || list.length === 0) {
    // 上游返回了内容但解析不出条目 —— 多半是页面改版（选择器失效），归 PARSE 便于区分
    throw fail('PARSE', `Mikan 季度页（${year} ${season}）没有解析出任何番剧，可能页面结构变了`, {
      url: `${config.mikan.base}/Home/BangumiCoverFlowByDayOfWeek`,
      htmlLength: html?.length ?? 0,
    })
  }

  return list.slice(0, config.seasonLimit).map((item) => mikanToRow(item, { year, season }))
}

/**
 * 档案解析：Mikan 详情页一次请求，同时拿「权威 bgmId + 字幕组列表」
 * —— 后台守护进程「补齐整部作品档案」的入口（架构图里「传入 mikanid → 番名/bgmid/海报/字幕组列表」那条）
 * 注意：bgmId 可能为空（详情页没挂 Bangumi 链接）、字幕组可能为空（新番常见）—— 都是正常情况，照常返回。
 * @param {string|number} mikanId
 * @returns {Promise<{ bangumiId: string|null, subgroups: Array<{subgroupName:string, subgroupRSSId:string, subgroupMikanId:string}> }>}
 */
export async function fetchAnimeProfile(mikanId) {
  const html = await getAnimeDetailPage(config.mikan.base, mikanId)
  return {
    bangumiId: getAnimeBangumiId(html)?.bangumiId ?? null,
    subgroups: getSubGroupList(html) ?? [],
  }
}

/**
 * 只取权威 bgmId
 * @returns {Promise<string|null>}
 */
export async function fetchBgmIdByMikan(mikanId) {
  const { bangumiId } = await fetchAnimeProfile(mikanId)
  return bangumiId
}

/**
 * 某字幕组在某作品下的资源列表（种子）
 * ---------------------------------------------------------------------------
 * 上游是 Mikan 的 RSS（`/RSS/Bangumi?bangumiId=&subgroupid=`），一次请求拿全量，
 * 所以**不需要翻页**；「新番刚开播还没有资源」会解析出空数组 —— 那是正常情况，不是错误，
 * 照常返回空列表（前端显示空态），不要把面板整块搞成报错。
 * @param {string|number} mikanId  作品在 Mikan 的 id
 * @param {string|number} subgroupRssId 字幕组的 RSS id（subgroup.subgroup_rss_id）
 * @returns {Promise<Array<{title:string, magnet:string|null, magnetHash:string|null,
 *   torrentUrl:string|null, sizeText:string, publishedText:string}>>}
 */
export async function fetchSubgroupReleases(mikanId, subgroupRssId) {
  const xml = await getAnimeRSSPage(config.mikan.base, mikanId, subgroupRssId)
  const list = getAnimeReleaseFromRSS(xml)
  if (!Array.isArray(list)) return []
  return list.map(releaseToItem)
}
