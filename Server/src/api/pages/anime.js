/**
 * 作品详情聚合层 —— 侧边面板点开后要的那一份档案
 * ---------------------------------------------------------------------------
 * 与首页聚合层的区别：首页那一层只管排期；这一层是**面板看到啥就保证有啥**。
 *
 *   1. 面板要秒开：点海报只走一次 SQLite 主键查询
 *   2. **缺字段就现取一遍**（CONVENTIONS.md §10.4）：评分 / 标签 / 简介为空时，现场
 *      复用后台那套 `enrichOne()`（Mikan 详情页 + Bangumi 条目）补齐再读回来 ——
 *      补一次之后库里就有了，后续请求不再打上游。同一条 5 分钟内只补一次（防抖）。
 *   3. 字幕组 / 资源列表是**另外两条接口**，而且**每次都直接问上游**（不吃库、不缓存）：
 *      新番随时加字幕组、种子上新很频繁，只有现场取才是最新的；
 *      抓到顺手落库（下载队列 / 归档要用这些 id），但**不拿库里的当答案**。
 *   4. 系列：没算过就现场跑一遍走链（用户看了啥、库里没有就补一遍）
 */
import { warmPoster } from '../../cache/poster.js'
import { findById, listSeriesMembers, rememberSubgroups } from '../../db/anime.js'
import { enrichOne } from '../../jobs/enrich.js'
import { fillSeriesFor } from '../../jobs/series.js'
import { fail } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { toAnimeDetail, toSubgroupItem } from '../mappers/anime.js'
import { fetchAnimeProfile, fetchSubgroupReleases } from '../sources/mikan.js'

/** 现场补档的防抖窗口：同一条作品 5 分钟内只补一次（连点 / 来回切换不重复打上游） */
const ENRICH_DEBOUNCE_MS = 5 * 60 * 1000
const enrichedAt = new Map()

/** 档案字段缺了就该现取：有 bgm_id 才可能补到东西（评分 / 标签 / 简介任一为空） */
const needsEnrich = (row) =>
  Boolean(row?.bgm_id) && (row.score == null || row.tags == null || row.summary == null)

/**
 * 按作品主键取详情（缺字段现场补一次再返回）
 * @param {number|string} id 作品主键（前端卡片里的 item.id）
 * @param {{ log?: object }} [options]
 */
export async function getAnimeDetail(id, { log = logger } = {}) {
  const numId = Number(id)
  let row = findById(numId)
  if (!row) throw fail('NOT_FOUND', `没有 id=${numId} 的作品记录`)

  warmPoster(row) // 海报已在 DTO 里给了直链，这里只是顺手把它存到本地

  const last = enrichedAt.get(numId) ?? 0
  if (needsEnrich(row) && Date.now() - last > ENRICH_DEBOUNCE_MS) {
    enrichedAt.set(numId, Date.now())
    const outcome = await enrichOne(row, log)
    if (outcome === 'enriched') {
      row = findById(numId) ?? row // 补完读回来（这次响应就带上评分/标签/简介）
      log.info({ id: numId }, 'anime.detail 现场补齐')
    }
  }

  log.debug({ id: numId }, 'anime.detail ok')
  return toAnimeDetail(row)
}

/**
 * 作品下的字幕组列表 —— **每次都直接问 Mikan**（不吃库、不缓存，**也不存映射**）
 * ---------------------------------------------------------------------------
 * 一页详情页（`GET /Home/Bangumi/{mikanId}`）就带着「字幕组 + 各自的 RSS id」；
 * 返回给前端的 `id` 就是**该作品下的 rss id**，取资源时前端回传它即可
 * （`/releases?subgroupId=<id>`）—— 所以服务端不再存「(作品, 字幕组) → rss id」那张映射表。
 * 顺手把组名记进字典（`subgroup` 表，纯名字缓存，写失败不影响返回）。
 * 抓不到 → 空列表（不存关系，也就没有兜底可给），面板显示空态。
 * @returns {Promise<{ items: Array<{id:number,name:string,mikanId:string,rssId:string}>, source: 'mikan'|'none' }>}
 */
export async function getAnimeSubgroups(id, { log = logger } = {}) {
  const row = findById(id)
  if (!row) throw fail('NOT_FOUND', `没有 id=${id} 的作品记录`)

  if (!row.mikan_id) {
    log.warn({ id }, 'anime.subgroups no-mikan-id')
    return { items: [], source: 'none' }
  }

  try {
    const profile = await fetchAnimeProfile(row.mikan_id)
    // 没有 rss id 的组取不了资源（它连点都点不进去），顺手滤掉；同一个 rss id 只留一条
    const seen = new Set()
    const usable = profile.subgroups.filter((sg) => {
      const key = String(sg?.subgroupRSSId ?? '')
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    try {
      rememberSubgroups(profile.subgroups) // 只是名字字典
    } catch (err) {
      log.warn({ id, err: err.message }, 'anime.subgroups dict-write-fail')
    }
    const items = usable.map(toSubgroupItem)
    log.debug({ id, total: items.length, source: 'mikan' }, 'anime.subgroups ok')
    return { items, source: 'mikan' }
  } catch (err) {
    log.warn({ id, mikanId: row.mikan_id, err: err.message }, 'anime.subgroups fetch-fail')
    return { items: [], source: 'none' }
  }
}

/**
 * 同系列的作品 —— 面板标题旁「系列」chip 点开的那一份（CONVENTIONS.md §10.2）
 * ---------------------------------------------------------------------------
 * **没算过就现场跑一遍**：用户看到哪部、库里系列字段还空着，就当场走一次链
 * （1~8 次 1 跳 + 可能的 1 次 AI），顺带把链上其它已在库的成员一起标好。
 * 跑完照常返回；失败 / 真的没有别的成员 → 返回 null（前端据此不渲染 chip）。
 *
 * 只列**已在库**的成员：不在库的没有作品主键、点不进去，显示了也是死条目（前端「缺了就是无」）。
 * @param {number|string} id 作品主键
 */
export async function getAnimeSeries(id, { log = logger } = {}) {
  const numId = Number(id)
  let row = findById(numId)
  if (!row) throw fail('NOT_FOUND', `没有 id=${numId} 的作品记录`)

  if (!row.series_checked_at && row.bgm_id) {
    const outcome = await fillSeriesFor(row, { log })
    if (outcome === 'done') {
      row = findById(numId) ?? row
      log.info({ id: numId }, 'anime.series 现场补齐')
    } else {
      log.debug({ id: numId, outcome }, 'anime.series 现场补齐未成（照现状返回）')
    }
  }

  if (!row.series_id) return null

  const members = listSeriesMembers(row.series_id)
  // 单成员系列不值得显示「系列」chip（点开只有它自己）→ 与「没算过」一样返回 null
  if (members.length < 2) return null
  // 根名 / 命名风格只写在「代表行」上（代表行的 id 就是 series_id）
  const representative = members.find((m) => m.id === row.series_id)

  log.debug({ id: numId, seriesId: row.series_id, members: members.length }, 'anime.series ok')
  return {
    rootTitle: representative?.series_root_title || '',
    namingStyle: representative?.naming_style || null,
    currentIndex: row.series_index ?? null,
    items: members.map((m) => ({
      animeId: m.id,
      bgmId: m.bgm_id,
      /** 成品展示名：优先中文名（与 toAnimeDetail 同口径，不在前端拼） */
      title: m.title_cn || m.title,
      index: m.series_index,
      relation: m.series_relation,
      current: m.id === row.id,
    })),
  }
}

/**
 * 某字幕组的资源列表（种子）—— **每次直接问上游，不缓存**
 * ---------------------------------------------------------------------------
 * `subgroupRssId` 就是 `/subgroups` 返回的那个 `id`（**该作品下的** RSS id）。
 * 为什么不再做归属校验：那份「(作品, 字幕组) → rss id」的映射已经不存了，而 Mikan 的
 * RSS 本来就是公开数据 —— 传别部作品的 id 最多读到别部作品的公开列表，
 * 不会泄露我们库里的任何东西（这正是当初要校验的原因，现在不成立了）。
 * @param {number|string} id 作品主键
 * @param {number|string} subgroupRssId 字幕组在该作品下的 RSS id（/subgroups 的 id）
 */
export async function getSubgroupReleases(id, subgroupRssId, { log = logger } = {}) {
  const row = findById(id)
  if (!row) throw fail('NOT_FOUND', `没有 id=${id} 的作品记录`)

  const rssId = String(subgroupRssId ?? '')
  const base = { subgroup: { id: Number(rssId) || 0, name: '' }, items: [], total: 0, cached: false }

  if (!row.mikan_id || !rssId) {
    log.warn({ id, rssId, mikanId: row.mikan_id }, 'anime.releases missing-ids')
    return base
  }

  const items = await fetchSubgroupReleases(row.mikan_id, rssId)

  log.debug({ id, rssId, total: items.length }, 'anime.releases ok')
  return { ...base, items, total: items.length }
}
