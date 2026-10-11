/**
 * 作品详情聚合层 —— 侧边面板点开后要的那一份档案
 * ---------------------------------------------------------------------------
 * 与首页聚合层的区别：**详情本身纯读库，不碰上游**。
 *   1. 面板要秒开：点海报只走一次 SQLite 主键查询，不触发任何抓取
 *   2. 内容来自后台守护进程（jobs/worker.js）持续补齐的档案：评分 / 标签 / 简介 / 集数。
 *      有就是有、没有就是没有 —— 缺的块不显示，也不在这里现场去猜（为什么见 sources/bgm.js）
 *   3. 字幕组 / 资源列表是**另外两条接口**（getAnimeSubgroups / getSubgroupReleases）：
 *      它们要打上游、会慢，不能拖累「点开就有」的详情；资源列表还带进程内缓存。
 */
import { findById, listSeriesMembers, listSubgroups, replaceSubgroups } from '../../db/anime.js'
import { fail } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { upstreamCache } from '../../cache/mem.js'
import { toAnimeDetail, toSubgroupItem } from '../mappers/anime.js'
import { fetchAnimeProfile, fetchSubgroupReleases } from '../sources/mikan.js'

/** 资源列表的进程内缓存时长：种子上新不频繁，5 分钟足够，省得反复打上游 */
const RELEASES_TTL_MS = 5 * 60 * 1000

/**
 * 按作品主键取详情
 * @param {number|string} id 作品主键（前端卡片里的 item.id）
 * @param {{ log?: object }} [options]
 */
export function getAnimeDetail(id, { log = logger } = {}) {
  const row = findById(id)
  if (!row) throw fail('NOT_FOUND', `没有 id=${id} 的作品记录`)

  log.debug({ id }, 'anime.detail ok')
  return toAnimeDetail(row)
}

/**
 * 作品下的字幕组列表
 * ---------------------------------------------------------------------------
 * 库里优先（后台补齐时连同档案一起落的字幕组）；库里为空时**现场抓一次** Mikan 详情页补上：
 *   · 新番刚开播、或那 3 条拿不到 bgmId 的作品，后台可能还没轮到，但面板不该因此空着
 *   · 抓失败只 warn 并返回空列表（面板显示「暂无字幕组」），不把整块搞成错误态 ——
 *     上游抖一下不至于让用户连评分简介都看不了
 * @returns {Promise<{ items: Array<{id:number,name:string,mikanId:string,rssId:string}>, source: 'db'|'mikan' }>}
 */
export async function getAnimeSubgroups(id, { log = logger } = {}) {
  const row = findById(id)
  if (!row) throw fail('NOT_FOUND', `没有 id=${id} 的作品记录`)

  let rows = listSubgroups(id)
  let source = 'db'

  if (!rows.length && row.mikan_id) {
    try {
      const profile = await fetchAnimeProfile(row.mikan_id)
      if (profile.subgroups.length) {
        replaceSubgroups(id, profile.subgroups, row.mikan_id)
        rows = listSubgroups(id)
        source = 'mikan'
      }
    } catch (err) {
      log.warn({ id, mikanId: row.mikan_id, err: err.message }, 'anime.subgroups fetch-fail')
    }
  }

  log.debug({ id, source, total: rows.length }, 'anime.subgroups ok')
  return { items: rows.map(toSubgroupItem), source }
}

/**
 * 同系列的作品 —— 面板标题旁「系列」chip 点开的那一份（CONVENTIONS.md §10.2）
 * ---------------------------------------------------------------------------
 * 只列**已在库**的成员：不在库的没有作品主键、点不进去，显示了也是死条目（前端「缺了就是无」）。
 * 一条 `WHERE series_id = ?` 就够（`listSeriesMembers` 已按「正传在前、番外在后」排好）。
 * **没算过系列时返回 null**（不是错误）—— 前端据此不渲染 chip。
 * @param {number|string} id 作品主键
 */
export function getAnimeSeries(id, { log = logger } = {}) {
  const row = findById(id)
  if (!row) throw fail('NOT_FOUND', `没有 id=${id} 的作品记录`)
  if (!row.series_id) return null

  const members = listSeriesMembers(row.series_id)
  // 根名 / 命名风格只写在「代表行」上（代表行的 id 就是 series_id）
  const representative = members.find((m) => m.id === row.series_id)

  log.debug({ id, seriesId: row.series_id, members: members.length }, 'anime.series ok')
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
 * 某字幕组的资源列表（种子）
 * ---------------------------------------------------------------------------
 * 归属校验不能省：subgroupId 来自前端，必须先确认它**属于这部作品**，
 * 否则改个数字就能读出别部作品的资源（同一字幕组在不同作品下的 RSS id 是不同的）。
 * 结果按「作品 + 字幕组」缓存 5 分钟 —— 面板里来回点字幕组不会反复打上游。
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

  const key = `mikan:releases:${row.mikan_id}:${subgroup.subgroup_rss_id}`
  const hit = upstreamCache.get(key) !== undefined
  const items = await upstreamCache.wrap(
    key,
    () => fetchSubgroupReleases(row.mikan_id, subgroup.subgroup_rss_id),
    RELEASES_TTL_MS,
  )

  log.debug({ id, subgroupId: subgroup.id, total: items.length, cached: hit }, 'anime.releases ok')
  return { subgroup: toSubgroupItem(subgroup), items, total: items.length, cached: hit }
}
