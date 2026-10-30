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
import { claimBySignature, signatureFromSamples } from '../../lib/release-match.js'
import { classifyReleaseFormat } from './ai.js'
import { enrichOne } from '../../jobs/enrich.js'
import { fillSeriesFor } from '../../jobs/series.js'
import { fail } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { toAnimeDetail, toSubgroupItem } from '../mappers/anime.js'
import { fetchAnimeProfile, fetchSubgroupReleases } from '../sources/mikan.js'

/** 现场补档的防抖窗口：同一条作品 5 分钟内只补一次（连点 / 来回切换不重复打上游） */
const ENRICH_DEBOUNCE_MS = 5 * 60 * 1000
const enrichedAt = new Map()

/** 单组 feed 的「可能被截断」阈值：Mikan 对带 subgroupid 的 feed 只给最近 100 条 */
const TRUNCATE_HINT = 100

/** 格式特征缓存（按 作品+组）：样本短期不会变，6 小时内不重复问 AI */
const SIGNATURE_TTL_MS = 6 * 60 * 60 * 1000
const signatureCache = new Map()

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
 * @returns {Promise<{ items: Array<{id:number|string,name:string,mikanId:string,rssId:string}>, source: 'mikan'|'all-only'|'none' }>}
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
    // Mikan 详情页 404 = 条目在 Mikan 列表里还在、但**详情页被拿掉了**
    // （实测 龙珠超 547 / 怪物弹珠 624 / 星球大战幻境 2547 —— 季度列表仍有，详情页 404）。
    // 而它们的**资源 feed 还活着**（514 / 144 / 12 条）。所以这里退化成「全部字幕组」一项：
    // 前端选它 → `/releases?subgroupId=all` → 全量 feed，照样能取资源（只是没法按组筛）。
    if (/HTTP 404/.test(String(err?.message || ''))) {
      log.warn({ id, mikanId: row.mikan_id, fallback: 'all' }, 'anime.subgroups detail-404')
      return { items: [{ id: 'all', name: '全部字幕组', mikanId: '', rssId: '' }], source: 'all-only' }
    }
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
      log.info({ id: numId, source: 'on-demand' }, 'anime.series fill ok')
    } else {
      log.debug({ id: numId, outcome }, 'anime.series fill skipped')
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
 * `subgroupRssId` 就是 `/subgroups` 返回的那个 `id`（**该作品下的** RSS id）；
 * 传 `'all'` = 全部字幕组（不带 subgroupid 的**全量 feed**）。
 *
 * 为什么不能只用单组 feed：Mikan 对它只给**最近 100 条**（实测黑叶草 168 集只回 77~161 集），
 * 而不带 subgroupid 的全量 feed 是完整历史（369 条 / 1~169 集）。所以：
 *   · 单组 feed **没到 100 条** → 本来就是全的，直接用
 *   · 到了 100 条 → 判定「可能被截断」→ 拉全量，再用**这个组自己的格式特征**认领回来
 *     （特征：AI 从样本里抽，抽不出来用确定性推导；匹配是纯函数，见 lib/release-match.js）
 * 认领结果比样本还少 → 判定特征不可靠，退回样本（最坏也就是原来的 100 条，不会更差）。
 * @param {number|string} id 作品主键
 * @param {number|string} subgroupRssId 字幕组在该作品下的 RSS id（/subgroups 的 id），或 'all'
 */
export async function getSubgroupReleases(id, subgroupRssId, { log = logger } = {}) {
  const row = findById(id)
  if (!row) throw fail('NOT_FOUND', `没有 id=${id} 的作品记录`)

  const want = String(subgroupRssId ?? '')
  const base = { subgroup: { id: Number(want) || 0, name: '' }, items: [], total: 0, cached: false }

  if (!row.mikan_id) {
    log.warn({ id, want, mikanId: row.mikan_id }, 'anime.releases missing-ids')
    return base
  }

  // 「全部字幕组」：直接拉全量（完整历史，不分字幕组）
  if (want === 'all') {
    const items = await fetchSubgroupReleases(row.mikan_id)
    log.debug({ id, total: items.length, source: 'all' }, 'anime.releases ok')
    return { ...base, items, total: items.length, source: 'all' }
  }

  if (!want) {
    log.warn({ id, want, mikanId: row.mikan_id }, 'anime.releases missing-ids')
    return base
  }

  const own = await fetchSubgroupReleases(row.mikan_id, want)
  if (own.length < TRUNCATE_HINT) {
    log.debug({ id, rssId: want, total: own.length, source: 'subgroup' }, 'anime.releases ok')
    return { ...base, items: own, total: own.length, source: 'subgroup' }
  }

  // 正好 100 条 = 可能被截断 → 拉全量 + 按格式特征认领
  try {
    const all = await fetchSubgroupReleases(row.mikan_id)
    const signature = await resolveSignature(row.id, want, own, { log })
    const { items, matched, reliable } = claimBySignature(all, signature, own)
    log.info(
      { id, rssId: want, own: own.length, all: all.length, matched, reliable, source: reliable ? 'all-matched' : 'subgroup', signature },
      'anime.releases claim',
    )
    return {
      ...base,
      items,
      total: items.length,
      source: reliable ? 'all-matched' : 'subgroup',
      signature: signature || null,
    }
  } catch (err) {
    log.warn({ id, rssId: want, err: err.message, fallback: 'subgroup' }, 'anime.releases claim fail')
    return { ...base, items: own, total: own.length, source: 'subgroup' }
  }
}

/**
 * 取这个字幕组的**格式特征**：先让 AI 从样本里抽，抽不出来用确定性推导兜底
 * 按 (作品, 组) 缓存 6 小时 —— 样本短期内不会变，别反复问模型。
 */
async function resolveSignature(animeId, rssId, samples, { log }) {
  const key = `${animeId}:${rssId}`
  const hit = signatureCache.get(key)
  if (hit && Date.now() - hit.at < SIGNATURE_TTL_MS) return hit.sig

  const titles = samples.map((s) => s.title)
  const sig = (await classifyReleaseFormat(titles, { log })) || signatureFromSamples(titles)
  if (sig) signatureCache.set(key, { sig, at: Date.now() })
  return sig
}
