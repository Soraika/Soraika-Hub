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
  getAnimeTitle,
  getMikanSeasonPage,
  getSeasonAnimeList,
  getSubGroupList,
} from '../../clients/Mikan.js'
import { config } from '../../config.js'
import { fail } from '../../lib/errors.js'
import { mikanToRow, releaseToItem } from '../../lib/format.js'
import { logger } from '../../lib/logger.js'

/**
 * 抓某季排期 → anime 行数组
 * @param {number|string} year
 * @param {string} season 春 / 夏 / 秋 / 冬
 */
export async function fetchSeasonSchedule(year, season) {
  const html = await getMikanSeasonPage(config.mikan.base, year, season, 3, (text) =>
    // 空壳页校验：真季度页一定有番剧条目，一条都没有就是"这次没取到"（要重试，而不是当成空季）
    (getSeasonAnimeList(text)?.length ?? 0) > 0,
  )
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
 *
 * **两层重试**（"字幕组偶尔读不到"的解法）：
 *   1. 传输层：超时 / 5xx / 429 / 空响应 —— 由 clients/Mikan.js 重试（指数退避）
 *   2. 解析层：**200 但连标题都解析不出来** = 上游给了空壳页（反爬 / 限流 / 网关抽风），
 *      这不是"这部没有字幕组"，而是"这次没取到" → 这里再试一次
 * 再加一层并发去重：同一个 mikanId 只抓一次（面板连点 / 两个接口同时问都只花一次请求）。
 * @param {string|number} mikanId
 * @returns {Promise<{ bangumiId: string|null, subgroups: Array<{subgroupName:string, subgroupRSSId:string, subgroupMikanId:string}> }>}
 */
export async function fetchAnimeProfile(mikanId) {
  const key = String(mikanId)
  if (profileInflight.has(key)) return profileInflight.get(key)
  const task = loadProfile(key).finally(() => profileInflight.delete(key))
  profileInflight.set(key, task)
  return task
}

/** 详情页解析重试次数（传输层已在 client 里重试过，这里只兜"空壳页"） */
const PROFILE_ATTEMPTS = 2
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const profileInflight = new Map()

async function loadProfile(mikanId) {
  let htmlLength = 0
  for (let attempt = 1; attempt <= PROFILE_ATTEMPTS; attempt++) {
    const html = await getAnimeDetailPage(config.mikan.base, mikanId)
    const bangumiId = getAnimeBangumiId(html, { quiet: attempt > 1 })?.bangumiId ?? null
    const subgroups = getSubGroupList(html) ?? []
    // 真页面必有标题：标题都解析不出来 → 空壳页，重试
    if (getAnimeTitle(html)) return { bangumiId, subgroups }
    htmlLength = html?.length ?? 0
    if (attempt < PROFILE_ATTEMPTS) {
      const wait = 500 * 2 ** (attempt - 1)
      logger.warn({ mikanId, attempt, htmlLength, waitMs: wait }, 'mikan.profile retry')
      await sleep(wait)
    }
  }
  logger.error({ mikanId, htmlLength }, 'mikan.profile 反复解析为空（上游可能改版 / 限流）')
  return { bangumiId: null, subgroups: [] }
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
 * 某部作品的资源列表（种子）
 * ---------------------------------------------------------------------------
 * 上游是 Mikan 的 RSS（`/RSS/Bangumi?bangumiId=&subgroupid=`），一次请求拿全量，不需要翻页。
 * **`subgroupRssId` 传 null = 拉全量**（不带 subgroupid）：Mikan 对「单字幕组」那条 feed
 * 只给最近 100 条，而**不带 subgroupid 才是完整历史**（实测黑叶草：100 条 vs 369 条 / 1~169 集）。
 * 「新番刚开播还没有资源」会解析出空数组 —— 那是正常情况，不是错误。
 * @param {string|number} mikanId  作品在 Mikan 的 id
 * @param {string|number|null} [subgroupRssId] 字幕组在该作品下的 RSS id；`null` = 全部字幕组
 * @returns {Promise<Array<object>>}
 */
export async function fetchSubgroupReleases(mikanId, subgroupRssId = null) {
  const xml = await getAnimeRSSPage(config.mikan.base, mikanId, subgroupRssId)
  const list = getAnimeReleaseFromRSS(xml)
  if (!Array.isArray(list)) return []
  return list.map(releaseToItem)
}
