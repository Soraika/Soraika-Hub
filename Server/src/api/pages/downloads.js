/**
 * 下载（qBittorrent）聚合层 —— 下载页要的数据全部在这里拼
 * ---------------------------------------------------------------------------
 * **qB 是事实来源**：库里的 `anime` 只用来补「这是哪部番 / 海报 / 总集数」，
 * 不存下载状态（存了就必然和 qB 打架，还要写同步任务）。
 *
 * 三条接口对得上页面的两层结构：
 *   · `getDownloads()`      → 卡片墙：一部番一张卡（已下几集 / 体积 / 状态）
 *   · `getAnimeDownloads()` → 面板：字幕组（一级）→ 这个组下已下的集（二级）
 *   · `addDownloads()`      → 资源列表勾选后加种（归档目录 + 标签在这里定）
 */
import { config } from '../../config.js'
import { findById, findByMikanId, findByTitle } from '../../db/anime.js'
import {
  archiveDirOf,
  buildTags,
  episodeOf,
  episodeOrder,
  kindOf,
  mikanIdOf,
  percentOf,
  seasonIndexOf,
  sizeText,
  splitSavePath,
  stateTextOf,
  subgroupOf,
  tagsOf,
} from '../../lib/downloads.js'
import { metaFromTags, metaOfText, metaTagsOf, releaseMetaTags } from '../../lib/release-tags.js'
import { fail } from '../../lib/errors.js'
import { posterUrlOf } from '../../lib/format.js'
import { logger } from '../../lib/logger.js'
import { qbAddTorrent, qbConfigured, qbTorrents, qbTransfer, qbVersions } from '../sources/qb.js'

/** 认不出的组名（老种子 / 手动加种没有 `sg:` 标签时都落这里） */
const UNKNOWN_GROUP = '未标注字幕组'

/**
 * 一个种子 → 界面条目
 * `name` 是 qB 里的种子名（原始资源标题），`fileName` 才是落盘后的文件名 ——
 * 集数从**落盘名**取：改过名的种子那里是规范的 `S01E04`，比原始标题准。
 *
 * `subgroup` / `tags`（画质·字幕·片源）也在这里定：
 *   组名 → 标签 `sg:` → 旧格式最后一格 → 种子名；
 *   画质字幕 → **标签优先**（加种时写进去的，改名也不丢）→ 名字兜底（历史种子）。
 */
function normalizeTorrent(t) {
  const root = config.qb?.saveRoot
  const { title: dirTitle, seasonDir } = splitSavePath(t.save_path, root)
  const fileName = String(t.content_path || '').split('/').pop() || ''
  const episode = episodeOf(fileName) || episodeOf(t.name)
  const tags = tagsOf(t.tags)
  const meta = metaFromTags(tags)
  return {
    hash: t.hash,
    name: t.name,
    fileName,
    dirTitle,
    season: seasonIndexOf(seasonDir),
    seasonDir,
    episode,
    /** 字幕组（扁平列表里每行都要标一个；认不出就空串，界面显示「未标注」） */
    subgroup: subgroupOf(t.tags, t.name),
    /** 画质 / 字幕 / 片源（最多 3 个，已去重） */
    tags: releaseMetaTags(meta, `${t.name || ''} ${fileName}`, 3),
    kind: kindOf(t.state),
    state: t.state,
    stateText: stateTextOf(t.state),
    progress: percentOf(t.progress),
    sizeBytes: Number(t.size) || 0,
    sizeText: sizeText(t.size),
    addedAt: Number(t.added_on) || 0,
    completedAt: Number(t.completion_on) || 0,
    savePath: t.save_path,
    contentPath: t.content_path,
    speedText: t.dlspeed ? `${sizeText(t.dlspeed)}/s` : '',
    eta: Number(t.eta) || 0,
  }
}

/**
 * 种子 → 作品行（认不出返回 null）
 * 先看标签里的 Mikan 番剧 id（准），再看归档目录名（次准）。
 * 另外 50 条老种子**标签是空的**，但种子名本身就是旧格式 —— `mikanIdOf` 会退到名字里找。
 */
function resolveAnime(torrent) {
  const mikanId = mikanIdOf(torrent.tags, torrent.name)
  if (mikanId) {
    const row = findByMikanId(mikanId)
    if (row) return row
  }
  const { title } = splitSavePath(torrent.save_path, config.qb?.saveRoot)
  return title ? findByTitle(title) : null
}

/** 一部番的一批种子 → 卡片数据 */
function cardOf(row, torrents) {
  const items = torrents.map(normalizeTorrent)
  const downloading = items.filter((it) => it.kind === 'downloading')
  const done = items.filter((it) => it.kind === 'done')
  const missing = items.filter((it) => it.kind === 'missing')
  const latest = items.map((it) => episodeOrder(it.episode)).filter(Boolean).sort((a, b) => b - a)[0] || 0
  const sizeBytes = items.reduce((n, it) => n + it.sizeBytes, 0)
  const seasons = [...new Set(items.map((it) => it.season))].sort((a, b) => a - b)

  /** 一张卡只能有一个状态：还在下 → 下载中；有丢失 → 文件丢失；否则已完成 */
  const state = downloading.length ? 'downloading' : missing.length ? 'missing' : 'done'
  return {
    /** 卡片契约里的主键就叫 id（`CardGrid` / `orderKeyOf` 全站认这一个字段） */
    id: row.id,
    animeId: row.id,
    title: row.title_bgm || row.title_mikan || row.title_bgm_origin,
    poster: posterUrlOf(row),
    count: items.length,
    doneCount: done.length,
    downloadingCount: downloading.length,
    missingCount: missing.length,
    latestEpisode: latest,
    totalEpisodes: Number(row.total_episodes) || 0,
    episodes: items.map((it) => it.episode).filter(Boolean),
    seasons,
    season: seasons[0] ?? 0,
    sizeBytes,
    sizeText: sizeText(sizeBytes),
    state,
    stateText: state === 'downloading' ? '下载中' : state === 'missing' ? '文件丢失' : '已完成',
    /** 进度：只对「下载中」有意义（多条时取平均，卡片上是个粗略指示） */
    progress: downloading.length
      ? Math.round(downloading.reduce((n, it) => n + it.progress, 0) / downloading.length)
      : 100,
    speedText: downloading.map((it) => it.speedText).filter(Boolean)[0] || '',
  }
}

/**
 * 下载页卡片墙
 * @param {{ fresh?: boolean }} [options] fresh = 用户点了「刷新」（跳过 4 秒缓存）
 */
export async function getDownloads({ fresh = false } = {}) {
  const empty = {
    configured: false,
    versions: null,
    transfer: null,
    counts: { total: 0, downloading: 0, done: 0, missing: 0, anime: 0, sizeBytes: 0, sizeText: '' },
    items: [],
    unmatched: [],
  }
  if (!qbConfigured()) return empty

  const [versions, transfer, torrents] = await Promise.all([
    qbVersions(),
    qbTransfer().catch(() => null), // 传输信息拿不到不该让整页失败
    qbTorrents({ fresh }),
  ])

  /** 作品 id → 该作品的种子（Map 保持 qB 返回顺序，卡片顺序稳定） */
  const byAnime = new Map()
  const unmatched = new Map()
  for (const t of torrents) {
    const row = resolveAnime(t)
    if (row) {
      if (!byAnime.has(row.id)) byAnime.set(row.id, { row, list: [] })
      byAnime.get(row.id).list.push(t)
      continue
    }
    // 认不出的：按归档目录名归堆（让人知道「这些文件在盘上，但系统不认识它属于哪部」）
    const { title } = splitSavePath(t.save_path, config.qb?.saveRoot)
    const key = title || String(t.name || '').slice(0, 40)
    if (!unmatched.has(key)) unmatched.set(key, [])
    unmatched.get(key).push(t)
  }

  const items = [...byAnime.values()]
    .map(({ row, list }) => cardOf(row, list))
    // 下载中排最前（那是「正在发生的事」），其余按最新集倒序
    .sort(
      (a, b) =>
        (a.state === 'downloading' ? 0 : 1) - (b.state === 'downloading' ? 0 : 1) || b.latestEpisode - a.latestEpisode,
    )

  const all = [...byAnime.values()].flatMap((g) => g.list.map(normalizeTorrent))
  const sizeBytes = all.reduce((n, it) => n + it.sizeBytes, 0)

  return {
    configured: true,
    versions,
    transfer,
    counts: {
      total: all.length,
      downloading: all.filter((it) => it.kind === 'downloading').length,
      done: all.filter((it) => it.kind === 'done').length,
      missing: all.filter((it) => it.kind === 'missing').length,
      anime: items.length,
      sizeBytes,
      sizeText: sizeText(sizeBytes),
    },
    items,
    unmatched: [...unmatched.entries()].map(([name, list]) => {
      const norm = list.map(normalizeTorrent)
      return {
        name,
        count: norm.length,
        sizeText: sizeText(norm.reduce((n, it) => n + it.sizeBytes, 0)),
        stateText: norm[0]?.stateText || '',
      }
    }),
  }
}

/**
 * 面板「资源」区：**一部番一份扁平清单** + 一个字幕组筛选条
 * ---------------------------------------------------------------------------
 * 为什么不按字幕组分成几个独立列表（之前那样）：
 *   · 一部番往往只有 1~2 个组在活动，分组后 90% 的组只有 1 条 —— 点两下才看得到
 *   · 用户关心的是「我下到第几集了」，不关心「这一集是谁压的」（组名是附注，不是维度）
 * 所以：清单按集号倒序铺平，每行自带组名；`groups` 只用来画顶部筛选条（全部 / 各组）。
 * @param {number|string} animeId 作品主键
 */
export async function getAnimeDownloads(animeId, { log = logger } = {}) {
  const row = findById(Number(animeId))
  if (!row) throw fail('NOT_FOUND', `没有 id=${animeId} 的作品记录`)

  const base = {
    animeId: row.id,
    title: row.title_bgm || row.title_mikan || row.title_bgm_origin,
    groups: [],
    items: [],
    total: 0,
    sizeText: '',
  }
  if (!qbConfigured()) return base

  const torrents = (await qbTorrents()).filter((t) => resolveAnime(t)?.id === row.id)
  const items = torrents.map(normalizeTorrent).sort((a, b) => episodeOrder(b.episode) - episodeOrder(a.episode))

  /** 筛选条用：组名 + 条数 + 体积（顺序按条数，多的在前） */
  const byGroup = new Map()
  for (const item of items) {
    const name = item.subgroup || UNKNOWN_GROUP
    item.subgroup = name // 空组名统一成「未标注字幕组」，界面直接显示
    const hit = byGroup.get(name) || { name, count: 0, bytes: 0 }
    hit.count++
    hit.bytes += item.sizeBytes
    byGroup.set(name, hit)
  }
  const groups = [...byGroup.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map((g) => ({ name: g.name, count: g.count, sizeText: sizeText(g.bytes) }))

  log.debug({ animeId: row.id, torrents: items.length, groups: groups.length }, 'downloads.anime ok')
  return {
    ...base,
    items,
    groups,
    total: items.length,
    sizeText: sizeText(items.reduce((n, it) => n + it.sizeBytes, 0)),
  }
}

/**
 * 加种（资源列表勾选后点「下载」）
 * ---------------------------------------------------------------------------
 * 归档目录与标签在这里定，**不在前端拼**：
 *   · 目录：`{qb.saveRoot}/{番名}/Season 01`（规范见 lib/downloads.js 与 ARCHITECTURE 决策 38）
 *   · 标签：`soraika` + `mid:{mikanId}` + `sg:{字幕组}` ——
 *     `mid` 是下载页把种子认回作品的依据，丢了它就只能靠目录名猜
 * @param {{ animeId: number, subgroup?: string, season?: number, items: Array<{ title: string, magnet?: string, torrentUrl?: string, episode?: string }> }} params
 */
export async function addDownloads({ animeId, subgroup = '', season = 1, items = [] } = {}, { log = logger } = {}) {
  const row = findById(Number(animeId))
  if (!row) throw fail('NOT_FOUND', `没有 id=${animeId} 的作品记录`)
  if (!Array.isArray(items) || !items.length) throw fail('BAD_REQUEST', '没有要下载的资源')

  const root = config.qb?.saveRoot
  const title = row.title_bgm || row.title_mikan || row.title_bgm_origin
  const savePath = archiveDirOf({ title, season, root })
  /** 基础标签：`soraika`（本程序加的）+ `mid`（认回作品的关键）+ `sg`（字幕组） */
  const baseTags = buildTags({ mikanId: row.mikan_id || '', subgroup })

  const added = []
  const failed = []
  for (const item of items) {
    const url = String(item.magnet || item.torrentUrl || '').trim()
    if (!url) {
      failed.push({ title: item.title, reason: '这条资源没有磁力 / 种子链接' })
      continue
    }
    /**
     * **加种时就把元数据写进标签**（`res:1080P` / `sub:简日内嵌` / `src:WEB-DL`）。
     * 这是唯一能扛住改名的存法：文件名改成 `番名 S01E04.mkv` 之后，画质与字幕信息
     * 在名字里就没了，事后**推不出来**（旧系统 113/176 条就是这么丢的）。
     */
    const meta = metaOfText(item.title)
    const tags = [baseTags, ...metaTagsOf(meta)].filter(Boolean).join(',')
    try {
      await qbAddTorrent({ url, savePath, tags, category: config.qb?.category })
      added.push({ title: item.title, episode: item.episode || episodeOf(item.title), tags })
    } catch (err) {
      failed.push({ title: item.title, reason: err.message })
    }
  }

  log.info(
    { animeId: row.id, savePath, tags: baseTags, added: added.length, failed: failed.length },
    'downloads.add done',
  )
  return { savePath, tags: baseTags, added, failed }
}
