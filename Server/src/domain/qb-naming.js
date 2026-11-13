/**
 * qB 改名的「规划层」—— 只算「该改成什么」，一个请求都不发
 * ---------------------------------------------------------------------------
 * **任务名和实际文件名是两个东西**，qB 也是两套接口：
 *   · 任务名        `POST /api/v2/torrents/rename`     参数 hash + name
 *                   = 种子的**根名字**。单文件种子就是那个文件，多文件种子是文件夹。
 *   · 种子内文件    `POST /api/v2/torrents/renameFile`  参数 hash + oldPath + newPath
 *                   路径相对种子根，**以 `/api/v2/torrents/files` 的 name 为准**（含子目录）。
 *   · 文件夹改名    `POST /api/v2/torrents/renameFolder`（4.3.3+，改名文件夹本身）
 *
 * 所以这里定一条硬规则：**永远不要从 `content_path` 猜文件名**。
 * 多文件种子的 content_path 是文件夹，尾段会拿到 `SE01` 这种目录名，
 * 于是「没有扩展名 → 不是单文件 → 跳过」，文件就永远改不了（线上真实发生）。
 *
 * 两种名字各自成对出现（from/to/reason/ok），调用方可以只改其中一个。
 */
import { episodeOf, extensionOf, fileNameOf, torrentNameOf } from './downloads.js'

/** 视频扩展名：只有这些才当作「这一集」去改名；字幕/字体/封面一律不碰 */
const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.ts', '.m4v', '.mov', '.webm', '.flv', '.wmv', '.rmvb'])
/** 外挂字幕：跟着同名视频一起改（只认同名，不做模糊匹配） */
const SUB_EXT = new Set(['.ass', '.srt', '.ssa', '.vtt', '.sub'])

/** 路径拆成 目录 + 主名 + 扩展名（分隔符统一成 /，qB 一律用 /） */
export function splitPath(p) {
  const text = String(p || '').replace(/\\/g, '/')
  const cut = text.lastIndexOf('/')
  const dir = cut >= 0 ? text.slice(0, cut + 1) : ''
  const base = cut >= 0 ? text.slice(cut + 1) : text
  const ext = extensionOf(base)
  return { dir, base, stem: ext ? base.slice(0, -ext.length) : base, ext }
}

/** 这个路径是不是视频（按扩展名，不猜内容） */
export const isVideoPath = (p) => VIDEO_EXT.has(splitPath(p).ext)
export const isSubPath = (p) => SUB_EXT.has(splitPath(p).ext)

/**
 * 集数是否可信
 * ---------------------------------------------------------------------------
 * 旧方括号任务名的第 4 格是集数，但**有些种子里那一格写的是番剧 id**
 * （线上实例：`[4111][…][1][4111][][生肉 不明字幕]`，集数被写成了 mikanId）。
 * 所以集数只要等于 mikanId、或超出合理区间，就当认不出 —— 宁可不改，也不改名成假集数。
 */
export function plausibleEpisode(episode, mikanId = '') {
  const text = String(episode || '').trim()
  if (!/^\d{1,4}(-\d{1,4})?$/.test(text)) return false
  const [from, to] = text.split('-').map(Number)
  if (from < 1 || from > 1999) return false
  if (to !== undefined && (to <= from || to > 2000)) return false
  const id = Number(mikanId) || 0
  // 集数 == 番剧 id：几乎一定是解析错了，别信
  if (id && from === id) return false
  return true
}

/**
 * 规划一条种子的两种名字
 * @param {Object} params
 * @param {string} params.name        - qB 里的任务名（当前）
 * @param {Array<{name:string,size?:number}>} params.files - `/torrents/files` 的原样返回
 * @param {string} params.title       - 番名（库里的 title）
 * @param {string} [params.mikanId]
 * @param {number} [params.season]
 * @param {string} [params.subgroup]
 * @param {string} [params.rssId]
 * @param {string} [params.episodeHint] - 额外线索（资源标题里的集号），任务名用
 * @returns {{ torrentName: object, files: object[], summary: object }}
 */
export function planNaming({ name, files = [], title, mikanId = '', season = 1, subgroup = '', rssId = '', episodeHint = '' }) {
  const seasonNum = Math.max(1, Number(season) || 1)
  const clean = String(title || '').trim()

  const videos = files.filter((f) => isVideoPath(f.name))
  /** 视频文件里的集号（多文件种子一集一个视频；已改过名的文件这里是规范的 S01E04） */
  const videoEpisodes = videos
    .map((f) => episodeOf(splitPath(f.name).stem))
    .filter((ep) => plausibleEpisode(ep, mikanId))

  /* ── 任务名 ─────────────────────────────────────────────── */
  /* 集数取信顺序：任务名第 4 格 → 视频文件名 → 资源标题。
     第 4 格不可信（等于番剧 id / 超范围）时**往下找**，而不是直接放弃 ——
     线上那条 `[…][1][4111][…]` 里面明明有 S01E01，任务名却被这个 4111 判死了。 */
  const fromName = episodeOf(name)
  const torrentEpisode =
    (plausibleEpisode(fromName, mikanId) && fromName) ||
    (videoEpisodes.length ? videoEpisodes[0] : '') ||
    (plausibleEpisode(episodeHint, mikanId) ? String(episodeHint).trim() : '')

  const wantTorrentName = clean && torrentEpisode
    ? torrentNameOf({ title: clean, mikanId, season: seasonNum, episode: torrentEpisode, subgroup, rssId })
    : null

  const torrentName = {
    from: String(name || ''),
    to: wantTorrentName || '',
    /* 名字没变就不算「要改」；但要把「为什么没变」说清楚（已符合 vs 算不出来） */
    ok: Boolean(wantTorrentName) && wantTorrentName !== name,
    reason: '',
  }
  if (!wantTorrentName) {
    torrentName.reason = !clean ? '没有番名' : '认不出集数'
  } else if (wantTorrentName === name) {
    torrentName.reason = '已符合'
  }

  /* ── 种子内文件 ────────────────────────────────────────── */
  const out = []
  const targets = new Map() // 目标路径 → 源路径（qB 撞名会回 409，先自己查出来）
  /** 视频：旧主名 → 新的主名（外挂字幕按它改名） */
  const videoStems = new Map()

  for (const f of files) {
    const src = String(f.name || '')
    if (!src || !isVideoPath(src)) continue
    const { dir, stem, ext } = splitPath(src)

    /* 集数：优先看这个文件自己的名字；多文件种子每个视频自带集号，认不出就用任务名那份 */
    const own = episodeOf(stem)
    const episode = plausibleEpisode(own, mikanId) ? own : (videos.length === 1 ? torrentEpisode : '')
    if (!episode || !/^\d{1,4}$/.test(episode)) {
      out.push({ from: src, to: '', ok: false, kind: 'video', reason: '认不出集数' })
      continue
    }
    const want = clean ? fileNameOf({ title: clean, season: seasonNum, episode, ext }) : null
    if (!want) {
      out.push({ from: src, to: '', ok: false, kind: 'video', reason: '算不出目标文件名' })
      continue
    }
    const to = `${dir}${want}`
    const newStem = want.slice(0, -ext.length)
    videoStems.set(`${dir}${stem}`, { newStem, episode })
    if (to === src) {
      out.push({ from: src, to, ok: false, kind: 'video', reason: '已符合' })
      continue
    }
    if (targets.has(to)) {
      out.push({ from: src, to, ok: false, kind: 'video', reason: '与同种子另一个文件撞名' })
      continue
    }
    targets.set(to, src)
    out.push({ from: src, to, ok: true, kind: 'video', reason: '' })
  }

  /* ── 外挂字幕：跟视频走 ────────────────────────────────────
   * 判据是**集号相同 + 同目录**（不是主名相同）：不同字幕组的命名风格差很多
   * （`[Sakurato] xxx [24]…` vs `xxx S01E24…`），按主名匹配会漏掉一大半。
   * 新主名用视频的，语言标记（.sc / .tc / .chs / .cq / .jpn …）保留 —— 那是唯一
   * 区分简繁的信息，丢掉就等于毁掉字幕。 */
  for (const f of files) {
    const sub = String(f.name || '')
    if (!sub || !isSubPath(sub)) continue
    const sp = splitPath(sub)
    const direct = videoStems.get(`${sp.dir}${sp.stem}`)
    let target = direct
    if (!target) {
      const ep = episodeOf(sp.stem)
      if (plausibleEpisode(ep, mikanId)) {
        for (const [key, val] of videoStems) {
          const cut = key.lastIndexOf('/')
          const keyDir = cut >= 0 ? key.slice(0, cut + 1) : ''
          if (val.episode === ep && keyDir === sp.dir) {
            target = val
            break
          }
        }
      }
    }
    if (!target) continue
    const lang = (sp.stem.match(/[._-](sc|tc|chs|cht|cq|jpn|jp|zh|en|eng|kor)(?=[._-]|$)/i) || [])[1]
    const to = `${sp.dir}${target.newStem}${lang ? `.${lang.toLowerCase()}` : ''}${sp.ext}`
    if (to === sub) continue
    if (targets.has(to)) continue
    targets.set(to, sub)
    out.push({ from: sub, to, ok: true, kind: 'sub', reason: '' })
  }

  const pending = out.filter((r) => r.ok)
  return {
    torrentName,
    files: out,
    summary: {
      renameTorrent: torrentName.ok,
      renameFiles: pending.length,
      actionable: torrentName.ok || pending.length > 0,
    },
  }
}

/** 给界面用的一句话总结（跳过原因优先讲清楚，别只说「已符合」） */
export function explainPlan(plan) {
  const bits = []
  if (plan.torrentName.ok) bits.push('任务名')
  const n = plan.files.filter((f) => f.ok).length
  if (n) bits.push(`${n} 个文件`)
  if (bits.length) return `将改：${bits.join(' + ')}`
  const reasons = [...new Set([plan.torrentName.reason, ...plan.files.map((f) => f.reason)].filter(Boolean))]
  return reasons.length ? `没有可改的（${reasons[0]}）` : '没有可改的'
}
