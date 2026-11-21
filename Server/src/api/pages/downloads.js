/**
 * 下载（qBittorrent）聚合层 —— 下载页要的数据全部在这里拼
 * ---------------------------------------------------------------------------
 * qB 是事实来源：库里的 `anime` 只用来补「这是哪部番 / 海报 / 总集数」，
 * 不存下载状态（存了就必然和 qB 打架，还要写同步任务）。
 *
 * 三条接口对得上页面的两层结构：
 *   · `getDownloads()`      → 卡片墙：一部番一张卡（已下几集 / 体积 / 状态）
 *   · `getAnimeDownloads()` → 面板：字幕组（一级）→ 这个组下已下的集（二级）
 *   · `addDownloads()`      → 资源列表勾选后加种（归档目录 + 标签在这里定）
 */
import { config } from './../../config.js'
import { ensureBgmStub, findById, findByMikanId, findByTitle, listForFolderMatch, rssIdOfSubgroup } from './../../db/anime.js'
import { matchByFolderIndex } from './../../db/relation.js'
import {
  archiveDirOf,
  buildTags,
  episodeOf,
  episodeOrder,
  kindOf,
  matchFolders,
  mikanIdOf,
  missingEpisodesOf,
  percentOf,
  seasonIndexOf,
  sizeText,
  splitSavePath,
  stateTextOf,
  subgroupOf,
  tagsOf,
} from './../../domain/downloads.js'
import { explainPlan, plausibleEpisode, planNaming } from './../../domain/qb-naming.js'
import { torrentMetaOf } from './../../lib/torrent-meta.js'
import { metaFromTags, metaOfText, metaTagsOf, releaseMetaTags } from './../../domain/release-tags.js'
import { fail } from './../../lib/errors.js'
import { posterUrlOf } from './../../lib/format.js'
import { logger } from './../../lib/logger.js'
import { qbAddTorrent, qbAddTorrentFile, qbConfigured, qbRenameFile, qbRenameTorrent, qbTorrentFiles, qbTorrents, qbTransfer, qbVersions } from './../sources/qb.js'

/** 一条资源对应哪个 btih：磁力里的、或 .torrent 文件名里的（RSS 的 pageLink 末段也是它） */
function hashOfRelease(item) {
  const text = `${item.magnet || ''} ${item.torrentUrl || ''} ${item.magnetHash || ''}`
  const m = text.match(/urn:btih:([0-9a-z]{32,40})/i) || text.match(/([0-9a-f]{40})\.torrent/i) || text.match(/\b([0-9a-f]{40})\b/i)
  return m ? m[1].toLowerCase() : ''
}

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
  /* content_path 对**多文件种子**是文件夹（等于 save_path），尾段是 `SE01` 这种目录名 ——
     那不是文件名，不能拿去显示、更不能拿去 when 改名。这里如实留空。 */
  const contentPath = String(t.content_path || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const savePath = String(t.save_path || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const isFolder = Boolean(contentPath) && contentPath === savePath
  const fileName = contentPath && !isFolder ? contentPath.split('/').pop() : ''
  /* 集数：文件名的优先；任务名第 4 格可能是番剧 id（`[4111][…][1][4111][…]`），
     不合理的当认不出，别在界面上写「第 4111 集」。 */
  const guess = episodeOf(fileName) || episodeOf(t.name)
  const episode = plausibleEpisode(guess, mikanIdOf(t.tags, t.name)) ? guess : ''
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
  const totalEpisodes = Number(row.total_episodes) || 0

  /* 缺哪集：断号（真漏了下）与尾部（还没下）分开算 —— 文案在这里定稿：
     卡片上就是「已下 12 / 共 25」+「缺 03 07」或「后 13 集未下」。 */
  const { have, missing: missingEps, tail, parsed } = missingEpisodesOf(items.map((it) => it.episode), totalEpisodes)
  const progressText = totalEpisodes && parsed ? `已下 ${have} / 共 ${totalEpisodes}` : ''
  const missingText = !progressText
    ? ''
    : !missingEps.length && !tail
      ? '已齐'
      : missingEps.length > 12
        ? `缺 ${missingEps.length} 集`
        : missingEps.length
          ? `缺 ${missingEps.map((n) => String(n).padStart(2, '0')).join(' ')}`
          : `后 ${tail} 集未下`

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
    totalEpisodes,
    /** 已下的集数（去重、只算 1..总集数）与缺的集号（前 12 个，够界面列） */
    haveEpisodes: have,
    missingCount: missingEps.length,
    missingEpisodes: missingEps.slice(0, 12),
    /** 比已下最大集更靠后的集数（还没下，不是漏了） */
    tailCount: tail,
    progressText,
    missingText,
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

  /* 第一趟先用**确定性**的方式认（标签里的 mikan id / 番名完全相等）；
     认不出的顺手把「归档目录名」记下来，第二趟统一做归一化匹配 ——
     一次取全表、一次建索引，比每个种子都查一次库便宜，也比逐条猜更可解释。 */
  const pending = []
  const resolved = new Map()
  for (const t of torrents) {
    const row = resolveAnime(t)
    if (row) resolved.set(t.hash, row)
    else pending.push(t)
  }
  if (pending.length) {
    const folderOf = (t) => splitSavePath(t.save_path, config.qb?.saveRoot).title
    const folders = pending.map(folderOf).filter(Boolean)

    /* 第二趟第一步：在**库内**按归一化名字找（含系列根名兜底） */
    if (folders.length) {
      const hit = matchFolders(folders, listForFolderMatch())
      for (const t of pending) {
        const title = folderOf(t)
        const row = title ? hit.get(title) : null
        if (row) resolved.set(t.hash, row)
      }
    }

    /* 第二趟第二步：库里没有的，去 **dump 建的全站动画索引**里找。
       ------------------------------------------------------------------
       为什么要这一步：`anime` 只由 Mikan 排期写入，所以 2020 年前的老番、剧场版、
       冷门作在库里根本没有行 —— 文件明明在盘上，却只能进「未识别」。dump 全量导入后
       `bgm_stub` 有全站动画（名字 + 首播日），拿它兜底就能认出来；
       认出来之后**建骨架行进库**（`ensureBgmStub`：只有 bgm_id + 名字，没有 mikan_id /
       year / season，所以不会污染首页排期），卡片就有了海报和标题。
       —— 这就是「导入 dump 同步更新数据库」在下载页这一侧的落点。 */
    const stillPending = pending.filter((t) => !resolved.has(t.hash))
    if (stillPending.length) {
      const restFolders = stillPending.map(folderOf).filter(Boolean)
      const indexHit = matchByFolderIndex(restFolders)
      let created = 0
      for (const t of stillPending) {
        const title = folderOf(t)
        const found = title ? indexHit.get(title) : null
        if (!found) continue
        const row = ensureBgmStub({
          bgmId: found.bgmId,
          title: found.nameCn || found.name,
          titleCn: found.nameCn || null,
        })
        if (!row) continue
        resolved.set(t.hash, row)
        if (row.title_mikan == null && row.year == null) created++
      }
      if (created) logger.info({ created }, 'downloads.match by dump index（新建骨架行）')
    }
  }

  for (const t of torrents) {
    const row = resolved.get(t.hash) ?? null
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
 *   · 目录：`{qb.saveRoot}/{番名}/Season 01`（规范见 domain/downloads.js 与 ARCHITECTURE 决策 38）
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
    let addedMeta = null
    const magnet = String(item.magnet || '').trim()
    const torrentUrl = String(item.torrentUrl || '').trim()
    if (!magnet && !torrentUrl) {
      failed.push({ title: item.title, reason: '这条资源没有磁力 / 种子链接' })
      continue
    }
    /**
     * 加种时就把元数据写进标签（`res:1080P` / `sub:简日内嵌` / `src:WEB-DL`）。
     * 这是唯一能扛住改名的存法：文件名改成 `番名 S01E04.mkv` 之后，画质与字幕信息
     * 在名字里就没了，事后**推不出来**（旧系统 113/176 条就是这么丢的）。
     */
    const meta = metaOfText(item.title)
    const tags = [baseTags, ...metaTagsOf(meta)].filter(Boolean).join(',')
    const hash = hashOfRelease(item)
    try {
      let result
      if (torrentUrl) {
        /* RSS 的默认产物就是 .torrent：**服务端取下来、把文件本体交给 qB**。
           不把 URL 甩给 qB —— 那要求 qB 自己能访问 Mikan（常常不行/被 522），
           而且磁力是我们用 hash 拼的（没有 tracker），速度也差。 */
        try {
          const res = await fetch(torrentUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 SoraikaHub', Referer: 'https://mikanime.tv/' },
            signal: AbortSignal.timeout(20000),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const buffer = Buffer.from(await res.arrayBuffer())
          if (!buffer.length) throw new Error('空种子')

          /* ── 用 .torrent 的元数据**当场**把名字定下来 ──────────────────
             磁力只有一个 hash，qB 拿到元数据前不知道里面是什么；`.torrent` 里
             `info.name` / `info.files` 是现成的，所以这一刻就能知道
             「单文件还是文件夹」以及「该叫什么」，直接让 qB 建的时候就用对名字
             （单文件种子 rename 改的就是那个文件本身）。 */
          const meta = torrentMetaOf(buffer)
          const naming = meta
            ? planNaming({
                name: meta.name,
                files: meta.files,
                title,
                mikanId: row.mikan_id || '',
                season,
                subgroup,
                rssId: rssIdOfSubgroup(subgroup),
                episodeHint: item.episode || episodeOf(item.title),
              })
            : null
          const preRename = naming?.torrentName.ok ? naming.torrentName.to : ''
          if (preRename) {
            log.info(
              { title: item.title, single: meta.single, files: meta.files.length, rename: preRename },
              'downloads.add prename',
            )
          }

          result = await qbAddTorrentFile({
            buffer,
            filename: `${hash || Date.now()}.torrent`,
            savePath,
            tags,
            category: config.qb?.category,
            rename: preRename,
          })
          addedMeta = meta
            ? { single: meta.single, files: meta.files.length, renamed: Boolean(preRename) }
            : null
        } catch (err) {
          // 取不到种子文件就退回「把 URL 交给 qB」（有些镜像不支持服务端取）
          log.warn({ title: item.title, err: err.message }, 'downloads.add torrent-fetch fallback')
          result = await qbAddTorrent({ url: torrentUrl, savePath, tags, category: config.qb?.category })
        }
      } else {
        result = await qbAddTorrent({ url: magnet, savePath, tags, category: config.qb?.category })
      }
      added.push({
        title: item.title,
        episode: item.episode || episodeOf(item.title),
        tags,
        /** 本来就在列表里（qB 409）—— 前端据此说「已存在」而不是「刚加入」 */
        existed: Boolean(result?.existed),
        /** hash：前端据此把这一条标成「已添加」（与 qB 里的 hash 对得上） */
        hash,
        /** 从 .torrent 读到的元数据（单文件 / 几个文件 / 是否加种时已定名） */
        torrent: addedMeta,
      })
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

/* ── 改名 ─────────────────────────────────────────────────────────────────
 * **任务名和实际文件名是两个东西**，这里从头到尾分开处理：
 *   scope='torrentName' → 只改 qB 列表里那个名字
 *   scope='fileName'    → 只改种子内的文件（存盘名）
 *   scope='all'         → 两个都按规则改
 * 文件列表一律取 `/api/v2/torrents/files` 的相对路径；**不再从 content_path 猜**
 * （多文件种子的 content_path 是文件夹，猜出来的"文件名"其实是目录名，永远改不动）。
 */

/** 番名：库里三个字段依次兜底（view 里有 title 视图字段，但老库里可能只有 title_mikan） */
const titleOfRow = (row) => row.title || row.title_bgm || row.title_mikan || row.title_bgm_origin || ''

/**
 * 一条种子 → 改名计划（只算，不写）
 * @param {object} torrent qB 原始种子
 * @param {object} row     库里的作品行
 */
async function planOf(torrent, row) {
  const item = normalizeTorrent(torrent)
  const files = await qbTorrentFiles(torrent.hash)
  const season = item.season || Number(row.series_index) || 1
  const plan = planNaming({
    name: torrent.name,
    files,
    title: titleOfRow(row),
    mikanId: row.mikan_id || '',
    season,
    subgroup: item.subgroup,
    rssId: rssIdOfSubgroup(item.subgroup),
  })
  return { torrent, item, files, plan }
}

/** 计划 → 真改（按 scope 挑一半做），返回做了什么 / 哪条失败 */
async function applyPlan({ hash, plan, scope = 'all' }, log) {
  const result = { torrentName: '', files: [], failed: [] }

  if (scope !== 'fileName' && plan.torrentName.ok) {
    try {
      await qbRenameTorrent({ hash, name: plan.torrentName.to })
      result.torrentName = plan.torrentName.to
    } catch (err) {
      result.failed.push({ what: '任务名', from: plan.torrentName.from, to: plan.torrentName.to, reason: err.message })
    }
  }

  if (scope !== 'torrentName') {
    for (const f of plan.files.filter((x) => x.ok)) {
      try {
        await qbRenameFile({ hash, oldPath: f.from, newPath: f.to })
        result.files.push({ from: f.from, to: f.to })
      } catch (err) {
        result.failed.push({ what: '文件', from: f.from, to: f.to, reason: err.message })
      }
    }
  }

  if (result.failed.length) log?.warn?.({ hash, failed: result.failed }, 'downloads.rename item fail')
  return result
}

/**
 * 一部作品的重命名（面板按钮）
 * @param {{ animeId:number, dryRun?:boolean, scope?:'all'|'torrentName'|'fileName' }} params
 */
export async function renameDownloads({ animeId, dryRun = true, scope = 'all' } = {}, { log = logger } = {}) {
  const row = findById(Number(animeId))
  if (!row) throw fail('NOT_FOUND', `没有 id=${animeId} 的作品记录`)

  const torrents = await qbTorrents({ fresh: true })
  const mine = torrents.filter((t) => resolveAnime(t)?.id === row.id)
  const plan = []
  const skipped = []

  for (const t of mine) {
    /* metaDL = 磁力还没拿到元数据：没有文件列表，改名无从谈起（这就是要用 .torrent 的原因） */
    if (t.state === 'metaDL' || t.state === 'forcedMetaDL') {
      skipped.push({ hash: t.hash, name: t.name, reason: '还没有元数据（磁力在取种子信息），等它开始下载再改' })
      continue
    }
    let p
    try {
      p = await planOf(t, row)
    } catch (err) {
      skipped.push({ hash: t.hash, name: t.name, reason: err.message })
      continue
    }
    if (!p.plan.summary.actionable) {
      skipped.push({ hash: t.hash, name: t.name, reason: explainPlan(p.plan) })
      continue
    }
    plan.push({
      hash: t.hash,
      episode: p.item.episode,
      oldName: p.plan.torrentName.from,
      newName: p.plan.torrentName.to || p.plan.torrentName.from,
      renameTorrent: p.plan.torrentName.ok && scope !== 'fileName',
      /** 文件：界面要显示「旧 → 新」，一条种子可能多个视频（多文件种子） */
      filePlan: p.plan.files,
      renameFiles: p.plan.files.filter((f) => f.ok).length,
      summary: explainPlan(p.plan),
      _plan: p.plan,
    })
  }

  if (dryRun) {
    log.info({ animeId: row.id, plan: plan.length, skipped: skipped.length, scope }, 'downloads.rename dry-run')
    return { dryRun: true, scope, title: titleOfRow(row), plan, skipped }
  }

  const done = []
  const failed = []
  for (const item of plan) {
    const res = await applyPlan({ hash: item.hash, plan: item._plan, scope }, log)
    const clean = { ...item }
    delete clean._plan
    if (res.failed.length) failed.push({ ...clean, reason: res.failed[0].reason, failed: res.failed })
    else done.push({ ...clean, applied: res })
  }
  log.info({ animeId: row.id, done: done.length, failed: failed.length, scope }, 'downloads.rename done')
  return { dryRun: false, scope, title: titleOfRow(row), plan: plan.map(({ _plan, ...rest }) => rest), done, failed, skipped }
}

/**
 * 全库自动重命名（worker 每分钟 / 手动）
 * @param {{ limit?:number, dryRun?:boolean, scope?:string }} [options]
 */
export async function renameAllDownloads({ limit = 10, dryRun = true, scope = 'all' } = {}, { log = logger } = {}) {
  if (!qbConfigured()) return { configured: false, plan: [], done: [], failed: [], skipped: [], skippedCount: 0 }
  const torrents = await qbTorrents({ fresh: true })
  const plan = []
  const skipped = []
  let skippedCount = 0
  const noteSkip = (t, reason) => {
    skippedCount++
    if (skipped.length < 20) skipped.push({ hash: t.hash, name: t.name, reason })
  }

  for (const t of torrents) {
    if (plan.length >= limit) break
    const row = resolveAnime(t)
    /* 认不出作品的**要说出来**（以前直接 continue，日志只有 done 0/0，看不出为什么） */
    if (!row) {
      noteSkip(t, '认不出是哪部作品（标签里没有 mid:，目录名也对不上库）')
      continue
    }
    if (t.state === 'metaDL' || t.state === 'forcedMetaDL') {
      noteSkip(t, '还没有元数据（磁力在取种子信息）')
      continue
    }
    let p
    try {
      p = await planOf(t, row)
    } catch (err) {
      noteSkip(t, err.message)
      continue
    }
    if (!p.plan.summary.actionable) continue // 已经符合规则的，静默跳过

    plan.push({
      hash: t.hash,
      animeId: row.id,
      episode: p.item.episode,
      oldName: p.plan.torrentName.from,
      newName: p.plan.torrentName.to || p.plan.torrentName.from,
      renameTorrent: p.plan.torrentName.ok && scope !== 'fileName',
      filePlan: p.plan.files,
      renameFiles: p.plan.files.filter((f) => f.ok).length,
      summary: explainPlan(p.plan),
      _plan: p.plan,
    })
  }

  if (dryRun) {
    log.info({ plan: plan.length, skipped: skippedCount, scope }, 'downloads.rename-all dry-run')
    return { configured: true, dryRun: true, scope, plan: plan.map(({ _plan, ...rest }) => rest), skipped, skippedCount }
  }

  const done = []
  const failed = []
  for (const item of plan) {
    const res = await applyPlan({ hash: item.hash, plan: item._plan, scope }, log)
    const clean = { ...item }
    delete clean._plan
    if (res.failed.length) failed.push({ ...clean, reason: res.failed[0].reason, failed: res.failed })
    else done.push({ ...clean, applied: res })
  }
  if (done.length || failed.length) {
    log.info({ done: done.length, failed: failed.length, skipped: skippedCount }, 'downloads.rename-all done')
  }
  return { configured: true, dryRun: false, scope, plan: plan.map(({ _plan, ...rest }) => rest), done, failed, skipped, skippedCount }
}

/**
 * 单个种子的改名详情（界面弹窗用）：当前两种名字 + 建议目标
 * @param {{ hash: string }} params
 */
export async function getTorrentNaming({ hash } = {}) {
  if (!qbConfigured()) throw fail('BAD_REQUEST', '还没配置 qBittorrent')
  const list = await qbTorrents({ fresh: true })
  const torrent = list.find((t) => String(t.hash).toLowerCase() === String(hash || '').toLowerCase())
  if (!torrent) throw fail('NOT_FOUND', 'qB 里没有这个种子')

  const files = await qbTorrentFiles(torrent.hash)
  const row = resolveAnime(torrent)
  const item = normalizeTorrent(torrent)
  const plan = row
    ? planNaming({
        name: torrent.name,
        files,
        title: titleOfRow(row),
        mikanId: row.mikan_id || '',
        season: item.season || Number(row.series_index) || 1,
        subgroup: item.subgroup,
        rssId: rssIdOfSubgroup(item.subgroup),
      })
    : { torrentName: { from: torrent.name, to: '', ok: false, reason: '认不出是哪部作品' }, files: files.map((f) => ({ from: f.name, to: '', ok: false, reason: '认不出是哪部作品' })), summary: { actionable: false } }

  return {
    hash: torrent.hash,
    animeId: row?.id ?? null,
    animeTitle: row ? titleOfRow(row) : '',
    episode: item.episode,
    state: torrent.state,
    stateText: stateTextOf(torrent.state),
    savePath: torrent.save_path,
    contentPath: torrent.content_path,
    /** 任务名：qB 列表里那一行（单文件种子 = 文件本身，多文件 = 文件夹） */
    torrentName: torrent.name,
    /** 种子内文件（相对路径，renameFile 的 oldPath 就是它） */
    files,
    /** 建议：按规则算出来的目标（可能为空 = 这条不改） */
    suggest: plan,
    summary: explainPlan(plan),
  }
}

/**
 * 手工改一个种子的名字（可只改任务名、只改某个文件，也可按建议一把改）
 * @param {{ hash:string, torrentName?:string, files?:Array<{oldPath:string,newPath:string}>, dryRun?:boolean }} params
 */
export async function renameTorrentItem({ hash, torrentName, files = [], dryRun = false } = {}, { log = logger } = {}) {
  if (!qbConfigured()) throw fail('BAD_REQUEST', '还没配置 qBittorrent')
  if (!hash) throw fail('BAD_REQUEST', '缺少种子 hash')
  const wantName = String(torrentName || '').trim()
  const pairs = (Array.isArray(files) ? files : [])
    .map((f) => ({ oldPath: String(f.oldPath || '').trim(), newPath: String(f.newPath || '').trim() }))
    .filter((f) => f.oldPath && f.newPath && f.oldPath !== f.newPath)

  if (!wantName && !pairs.length) throw fail('BAD_REQUEST', '没有要改的名字（任务名与文件名都为空）')

  if (dryRun) return { dryRun: true, torrentName: wantName, files: pairs }

  const done = []
  const failed = []
  if (wantName) {
    try {
      await qbRenameTorrent({ hash, name: wantName })
      done.push({ what: '任务名', to: wantName })
    } catch (err) {
      failed.push({ what: '任务名', to: wantName, reason: err.message })
    }
  }
  for (const pair of pairs) {
    try {
      await qbRenameFile({ hash, oldPath: pair.oldPath, newPath: pair.newPath })
      done.push({ what: '文件', ...pair })
    } catch (err) {
      failed.push({ what: '文件', ...pair, reason: err.message })
    }
  }
  log.info({ hash, done: done.length, failed: failed.length }, 'downloads.rename item done')
  return { dryRun: false, done, failed }
}
