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
import { findById, listSeriesMembers, listSubgroups, replaceSubgroups } from '../../db/anime.js'
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
 * 作品下的字幕组列表 —— **每次都直接问 Mikan**（不吃库、不缓存）
 * ---------------------------------------------------------------------------
 * 为什么不吃库：新番随时会加字幕组、旧的也可能改名换 RSS id，只有现场取才是最新的。
 * 抓到就 `replaceSubgroups` 落库（下载队列 / 归档要用这些 id），但**不拿库里的当答案**。
 * 上游抓不动时**退化到库里已有的**（有比没有好，面板不至于空着）+ 把失败记进日志 ——
 * 连着失败就是 Mikan 那边的问题，不该让用户看空列表。
 * @returns {Promise<{ items: Array<{id:number,name:string,mikanId:string,rssId:string}>, source: 'mikan'|'db-fallback'|'none' }>}
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
    if (profile.subgroups.length) replaceSubgroups(id, profile.subgroups, row.mikan_id)
    const items = listSubgroups(id).map(toSubgroupItem)
    log.debug({ id, total: items.length, source: 'mikan' }, 'anime.subgroups ok')
    return { items, source: 'mikan' }
  } catch (err) {
    const items = listSubgroups(id).map(toSubgroupItem)
    log.warn({ id, mikanId: row.mikan_id, err: err.message, fallback: items.length }, 'anime.subgroups fetch-fail')
    return { items, source: 'db-fallback' }
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
 * 为什么去掉缓存：种子上新很频繁，5 分钟缓存经常让用户看到旧列表（"怎么还没有新的"）。
 * 一次 RSS 请求很便宜，直接取最新的。
 * 归属校验不能省：subgroupId 来自前端，必须先确认它**属于这部作品**，
 * 否则改个数字就能读出别部作品的资源（同一字幕组在不同作品下的 RSS id 是不同的）。
 * @param {number|string} id 作品主键
 * @param {number|string} subgroupId subgroup 表的行主键
 */
export async function getSubgroupReleases(id, subgroupId, { log = logger } = {}) {
  const row = findById(id)
  if (!row) throw fail('NOT_FOUND', `没有 id=${id} 的作品记录`)

  const subgroup = listSubgroups(id).find((sg) => String(sg.id) === String(subgroupId))
  if (!subgroup) throw fail('NOT_FOUND', `作品 ${id} 下没有字幕组 ${subgroupId}`)

  // 老数据可能没存 RSS id（那列本来就是可空的）—— 取不到就老实给空列表
  if (!row.mikan_id || !subgroup.subgroup_rss_id) {
    log.warn(
      { id, subgroupId: subgroup.id, mikanId: row.mikan_id, rssId: subgroup.subgroup_rss_id },
      'anime.releases missing-ids',
    )
    return { subgroup: toSubgroupItem(subgroup), items: [], total: 0, cached: false }
  }

  const items = await fetchSubgroupReleases(row.mikan_id, subgroup.subgroup_rss_id)

  log.debug({ id, subgroupId: subgroup.id, total: items.length }, 'anime.releases ok')
  return { subgroup: toSubgroupItem(subgroup), items, total: items.length, cached: false }
}
