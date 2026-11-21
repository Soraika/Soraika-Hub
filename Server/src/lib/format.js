/**
 * 文案与归一化 —— 前端约定「成品字符串由后端给」，所以展示文案都在这里拼
 * ---------------------------------------------------------------------------
 *   1. 星期 → 区块标题 / 徽标（与前端示例数据逐字一致，含 7=剧场版、8=OVA）
 *   2. ratingText / metaText：前端不格式化，进接口前就拼好
 *   3. 标题归一化：Mikan（中文名）↔ Bangumi（name_cn / name）匹配用
 *   4. 来源条目 → anime 行：字段映射只在这里做，改来源字段只动这几个函数
 */
import { primaryBase } from './multi-source.js'
import { seasonOf } from './../domain/season.js'

/** 星期 → 区块标题/徽标。0=周日…6=周六 与 Mikan、前端 weekOrder.js 一致；7/8 是 Mikan 给的非星期内容 */
export const DAY_META = {
  0: { dayLabel: '周日', badge: '日' },
  1: { dayLabel: '周一', badge: '一' },
  2: { dayLabel: '周二', badge: '二' },
  3: { dayLabel: '周三', badge: '三' },
  4: { dayLabel: '周四', badge: '四' },
  5: { dayLabel: '周五', badge: '五' },
  6: { dayLabel: '周六', badge: '六' },
  7: { dayLabel: '剧场版', badge: '剧场' },
  8: { dayLabel: 'OVA', badge: 'OVA' },
}

/** 大数压缩：12000 → 1.2万；8600 → 8600 */
export function compactNumber(n) {
  const num = Number(n) || 0
  if (num < 10000) return String(num)
  return `${(num / 10000).toFixed(1).replace(/\.0$/, '')}万`
}

/**
 * 评分人数 → 成品字符串
 * 刻意**不设阈值**：新番刚开播只有几个人评分是真实情况，「9人评分」如实显示，
 * 让用户自己判断参考价值（隐藏低人数评分是之前我自己加的过滤，已经去掉）。
 */
export function ratingText(total) {
  const n = Number(total) || 0
  if (n <= 0) return ''
  return `${compactNumber(n)}人评分`
}

/**
 * 评分 → 成品字符串（固定一位小数）
 * 为什么要在后端补：库里是 REAL，Bangumi 的 8.0 读出来就是数字 8，
 * 模板直接渲染会显示「8」—— 同一部作品在卡片与详情会一个「8」一个「8.0」。
 * 展示口径统一在这里，前端不做格式化（前端连 toFixed 都不该写）。
 */
export function scoreText(score) {
  const n = Number(score)
  return Number.isFinite(n) && n > 0 ? n.toFixed(1) : ''
}

/**
 * meta_tags 里混着平台/地域类标签（TV、日本…），拼题材行时过滤掉，
 * 否则会拼出「2026 · 校园 TV」这种怪东西 —— 看着就不像题材。
 */
const TAG_BLOCKLIST = new Set([
  'TV',
  'OVA',
  'OAD',
  'ONA',
  'WEB',
  '剧场版',
  '电影',
  '日本',
  '中国',
  '韩国',
  '美国',
  '欧美',
  '国产',
])

/**
 * 从标签里挑出**题材** —— 过滤掉平台 / 媒体形式 / 地域类（TV、WEB、剧场版、日本…）与纯数字。
 * 卡片底部信息行（取 2 个）与详情面板标签区（取 8 个）**共用**它：口径必须一致，
 * 否则会出现「卡片写『奇幻 战斗』、面板第一格却是『TV 日本』」这种对不上的情况
 * （库里每条标签几乎都以 TV / 日本 开头，见 tmp-* 抽查）。
 * 返回可能是空数组（整部作品只有平台类标签）—— 要不要兜底由调用方决定：
 *   卡片：空就退化成「N 人在看」；面板：空才退回原始标签（标签区空着更没信息）。
 */
import { staticCandidates as staticPosterCandidates } from './../cache/poster-sources.js'

export function themeTags(tags, limit = 8) {
  return (tags || [])
    .filter((t) => t && !TAG_BLOCKLIST.has(t) && !/^\d+$/.test(t))
    .slice(0, limit)
}

/**
 * 底部信息行：`2026 · 奇幻 日常`
 * 题材优先用 Bangumi 标签（meta_tags 更规范，落库时已经排好序）；
 * 标签还没补齐时退化成 `2026 · 1.2万人在看`，避免只剩一个孤零零的年份。
 */
export function metaText({ year, tags, watching }) {
  const parts = []
  if (year) parts.push(String(year))
  const themes = themeTags(tags, 2)
  if (themes.length) parts.push(themes.join(' '))
  else if (watching > 0) parts.push(`${compactNumber(watching)}人在看`)
  return parts.join(' · ')
}

/** Mikan 的封面是相对路径（/images/...），补成绝对地址 */
export const absoluteUrl = (base, path) =>
  !path ? null : /^https?:\/\//i.test(path) ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`

/**
 * 卡片 / 详情的海报地址 —— **本地有就用本地，没有就直接给图源直链**
 * ---------------------------------------------------------------------------
 *   ① 本地已缓存（`poster_path`）→ `/api/img/anime/{id}`：走本地文件，最快、不吃防盗链
 *   ② 有图源但没缓存         → **图源直链**：浏览器立刻就能显示，不用等我们中转一次；
 *                              同时 `cache/poster.js#warmPoster` 在后台把图存到本地，
 *                              下一条就变成本地命中（这就是「直接返回 url，同时后端也下载」）
 *   ③ 既没缓存也没图源       → `/api/img/anime/{id}`：交出图接口现场问 Bangumi 要封面
 *                              （扫描来的行只有 bgm_id，占八成）—— 依然不空着
 *   ④ 连 bgm_id 都没有       → `''`（前端显示占位底纹，这是真的没有）
 *
 * 为什么不是「一律走 /api/img/anime/{id}」：那样每张图都要等我们回源一次（首页一屏
 * 十几张就是十几秒的等待），而且图源挂了我们才 302，用户先看到的是一片占位底纹。
 * 直链 + 后台预热是"看得见 + 存得下"两头都要。
 */
/**
 * 海报的**备选地址**（按顺序试，主图挂了才用）
 * ---------------------------------------------------------------------------
 * 用户报的问题：首页某张海报 404 就只剩占位底纹。原因是前端只拿到**一条**地址，
 * 浏览器 `onerror` 之后没有下一步可走。
 *
 * 这里给的是一条降级链（都**不发请求**，纯字符串）：
 *   ① 同一个 Mikan 图床的其它镜像域名（mikanime.tv / mikanani.me …）
 *   ② `/api/img/anime/{id}` —— 后端代理：它会再试镜像，最后去问 Bangumi 要封面，
 *      命中后还会把可用地址写回库（下一次①就对了）
 * 前端 `PosterImage` 按顺序换 src，全部失败才显示占位底纹。
 */
export const posterFallbacksOf = (row) => {
  if (!row?.id) return []
  const primary = row.poster_path ? `/api/img/anime/${row.id}` : row.poster_src || ''
  const list = []
  for (const url of staticPosterCandidates({ poster_src: row.poster_src })) {
    if (url && url !== primary && !list.includes(url)) list.push(url)
  }
  const proxy = `/api/img/anime/${row.id}`
  if (!list.includes(proxy)) list.push(proxy)
  return list
}

export const posterUrlOf = (row) => {
  if (!row?.id) return ''
  if (row.poster_path) return `/api/img/anime/${row.id}`
  if (row.poster_src) return row.poster_src
  return row.bgm_id ? `/api/img/anime/${row.id}` : ''
}

/** 标签列存的是 JSON 字符串，读出来还原成数组 */
export function parseTags(value) {
  if (!value) return []
  try {
    const arr = JSON.parse(value)
    return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string') : []
  } catch {
    return []
  }
}

/**
 * 字节数 → 成品大小文案（`1.4 GB` / `356.2 MB`）
 * RSS 给的是 contentLength（字符串数字）；拿不到就返回 ''（前端少显示一格，别显示 0 B）
 */
export function sizeText(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i >= 2 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/**
 * RSS 的 pubDate → 成品时间文案（`10-07 12:30`）
 * 只给「月-日 时:分」：资源列表里几乎都是当年的种子，写全年份反而挤掉标题；
 * 解析不出来返回 ''（不要显示 Invalid Date）。时间会换算到服务器本地时区 ——
 * 与旧版一致；要精确到时区得让前端自己格式化，那与本项目「前端不格式化」的约定冲突。
 */
export function publishedText(pubDate) {
  if (!pubDate) return ''
  const date = new Date(pubDate)
  if (Number.isNaN(date.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
}

/**
 * 修订版号 —— 同一集后期修版重发（各字幕组叫法不一样，这里统一成数字）
 * ---------------------------------------------------------------------------
 * 同一个东西在文件名里有一堆写法：`v2` / `V2` / `ver.2` / `第2版` / `修正版` /
 * `修订版` / `Rework` / `Repack`。前端要能"只看修正后的版本"，靠字符串比对做不到
 * （写法太多），所以在这里归一成数字：没标 = 1，v2 = 2，v3 = 3…
 *
 * 判定顺序按可靠性：显式 `vN` 最可靠，其次 `第N版`，再次 Rework/Repack，最后中文「修正/修订」。
 * 误判防护：`1080P` / `HEVC` / `x264` 里没有 v+数字；`AV1` 会命中但结果是 1（=原版，无影响）。
 * 这种确定性判定**不问 AI**（要花钱还不稳定），所以在 lib 里。
 */
export function revisionOf(title) {
  const text = String(title || '')
  if (!text) return 1

  const explicit = text.match(/[vV](?:er\.?)?\s?(\d{1,2})(?!\d)/)
  if (explicit) {
    const n = Number(explicit[1])
    return n >= 2 ? n : 1 // v1 就是原版，不算修订
  }

  const cn = text.match(/第\s?(\d{1,2})\s?版/)
  if (cn) {
    const n = Number(cn[1])
    return n >= 2 ? n : 1
  }

  const en = text.match(/(?:rework|repack|re-?release)\s*(\d{1,2})?/i)
  if (en) return en[1] ? Math.max(2, Number(en[1])) : 2

  if (/修正|修订|重制|重发/.test(text)) return 2

  return 1
}

/**
 * Mikan RSS 条目 → 资源列表项（面板「资源」区直接用）
 * Mikan 的 RSS 不给现成磁力链接，而是给详情页地址（末段 = info hash），
 * 所以磁力在这里拼 —— 与旧版同法。拿不到 hash 就给 null：前端少一个按钮，
 * 总比拼出一条点不动的坏链接好。
 * `revision` 是后端算好的修订版号（1 = 原版）：前端据此做「修订版优先」的筛选与标记，
 * 规则只有这一份，前端不重复实现。
 */
export function releaseToItem(release) {
  const hash = release.pageLink ? release.pageLink.split('/').pop() : null
  return {
    title: release.torrentTitle,
    magnetHash: hash || null,
    magnet: hash ? `magnet:?xt=urn:btih:${hash}` : null,
    torrentUrl: release.torrentUrl || null,
    sizeText: sizeText(release.torrentLength),
    publishedText: publishedText(release.pubDate),
    revision: revisionOf(release.torrentTitle),
  }
}

/** Mikan 季度页条目 → anime 行 */
export function mikanToRow(item, { year, season }) {
  return {
    mikan_id: item.mikanId == null ? null : String(item.mikanId),
    title_mikan: item.title,
    poster_src: absoluteUrl(primaryBase('mikan'), item.deParamCoverSrc),
    year,
    season,
    weekday: Number(item.dayofweek),
    source: 'mikan',
  }
}

/**
 * Bangumi 条目 → anime 行（评分补齐 / 只从 Bangumi 拿到的条目都走这里）
 * meta_tags 是公共标签（机战/TV/日本…），优先用它拼题材行，没有就退回 tags 前几名。
 */
export function bgmToRow(item, extra = {}) {
  const tags = (item.meta_tags?.length ? item.meta_tags : item.tags?.map((t) => t?.name)) || []
  const date = item.date || item.air_date || null
  return {
    ...extra,
    bgm_id: item.id == null ? null : String(item.id),
    title_cn: item.name_cn || null,
    poster_src: item.images?.large || item.images?.common || null,
    score: item.rating?.score ?? null,
    rating_total: item.rating?.total ?? null,
    tags: tags.filter(Boolean).slice(0, 8),
    watching: item.collection?.doing ?? null,
    summary: item.summary || null,
    // 排期归属以调用方给的为准（extra 优先）：Bangumi 的 air_date 可能落在季外
    // （跨季番 / 剧场版），若让它覆盖 year/season，条目会从当季查询里消失。
    year: extra.year ?? (date ? Number(date.slice(0, 4)) : null),
    season: extra.season ?? (date ? seasonOf(date) : null),
    air_date: date,
    total_episodes: item.total_episodes ?? item.eps ?? null,
    source: 'bgm',
  }
}
