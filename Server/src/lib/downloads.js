/**
 * 下载数据的纯函数层 —— 把 qBittorrent 的种子翻译成「下载页能直接摆」的形状
 * ---------------------------------------------------------------------------
 * 全部是纯函数（不碰 SQL、不发请求），所以能单测、也能被 worker / 将来 MCP 复用。
 *
 * 这里做的判断都有一条共同的出发点：**qB 是事实来源，本库只补名字**。
 *   · 种子 → 作品：优先看标签里的 Mikan 番剧 id（`soraika:[3990]` / `mid:3990`），
 *     认不出再退回「归档目录名 == 库里的番名」。两种都是确定性匹配，不猜。
 *   · 集数：文件名里的 `S01E04` 优先（那是我们自己改名后的规范写法），
 *     其次是 `[04]` / `- 04` / `第 4 集` / `[01-12]`（原样保留下来的旧种子）。
 *   · 状态：qB 的 state 有十几种，界面只区分四类 —— 下载中 / 已完成 / 文件丢失 / 其它异常。
 */

/** 归档根目录：`/downloads/anime/{番名}/SE01` 里的前两段（设置项 qb.saveRoot） */
const DEFAULT_ROOT = '/downloads/anime'

/** qB 状态 → 界面文案（没列到的保留原样，别装作懂） */
const STATE_TEXT = {
  downloading: '下载中',
  stalledDL: '下载中（无进度）',
  metaDL: '取元数据中',
  forcedMetaDL: '取元数据中',
  queuedDL: '排队中',
  checkingDL: '校验中',
  forcedDL: '下载中',
  allocating: '分配空间中',
  uploading: '上传中',
  stalledUP: '做种中',
  forcedUP: '做种中',
  queuedUP: '排队做种',
  checkingUP: '校验中',
  stoppedUP: '已完成',
  stoppedDL: '已暂停',
  pausedDL: '已暂停',
  pausedUP: '已暂停',
  moving: '移动文件中',
  missingFiles: '文件丢失',
  error: '出错',
  unknown: '未知',
}

/** 四大类（下载页按它分组 / 排序） */
const KIND_BY_STATE = {
  downloading: 'downloading',
  stalledDL: 'downloading',
  metaDL: 'downloading',
  forcedMetaDL: 'downloading',
  queuedDL: 'downloading',
  checkingDL: 'downloading',
  forcedDL: 'downloading',
  allocating: 'downloading',
  moving: 'downloading',
  checkingUP: 'done',
  uploading: 'done',
  stalledUP: 'done',
  forcedUP: 'done',
  queuedUP: 'done',
  stoppedUP: 'done',
  stoppedDL: 'done',
  pausedDL: 'done',
  pausedUP: 'done',
  missingFiles: 'missing',
  error: 'error',
}

export const stateTextOf = (state) => STATE_TEXT[state] || String(state || '未知')
export const kindOf = (state) => KIND_BY_STATE[state] || 'error'
/** 进度百分比（0–100 整数；qB 给的是 0–1） */
export const percentOf = (progress) => Math.max(0, Math.min(100, Math.round((Number(progress) || 0) * 100)))

/**
 * 人类可读体积：`4.2 GB` / `812 MB`
 * 与前端 `compactNumber` 不同：这里要的是文件体积语义（GB/MB），不是「万/亿」。
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
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** `/downloads/anime/{番名}/{SE01}` → `{ title, seasonDir }`（根目录可配，默认 /downloads/anime） */
export function splitSavePath(savePath, root = DEFAULT_ROOT) {
  const text = String(savePath || '').replace(/\\/g, '/')
  const base = String(root || DEFAULT_ROOT).replace(/\\/g, '/').replace(/\/+$/, '')
  const rest = text.startsWith(base) ? text.slice(base.length) : text
  const parts = rest.split('/').filter(Boolean)
  return { title: parts[0] || '', seasonDir: parts[1] || '' }
}

/**
 * 季目录 → 季号
 * 认三种写法：新规范 `Season 01` / 旧规范 `SE01` / 裸 `S2`；
 * 认不出返回 0（剧场版、手放的目录都落在这里，界面显示「其它」）
 */
export function seasonIndexOf(seasonDir) {
  const text = String(seasonDir || '')
  const hit = text.match(/(?:season|se|s)\s*0*(\d{1,2})/i)
  return hit ? Number(hit[1]) || 0 : 0
}


/* ── 标签 ──────────────────────────────────────────────────────────────── */

/**
 * 把 qB 的 tags 串拆开（qB 用逗号分隔，允许带空格）
 * @returns {string[]}
 */
export const tagsOf = (tags) => String(tags || '').split(',').map((s) => s.trim()).filter(Boolean)

/** 旧系统偶尔会把 JS 的 null 写进标签（`[1][null][null]`）—— 那不是名字，别当数据用 */
const isBlank = (v) => !v || String(v).trim() === '' || String(v).trim().toLowerCase() === 'null'

/**
 * 从标签里取 Mikan 番剧 id
 * ---------------------------------------------------------------------------
 * 三种来源，按可靠度排：
 *   ① 旧系统的 `soraika:[3990][番名][1][04][203][组名]`（实测 176 条里 126 条有）
 *   ② 现在写的 `mid:3990`
 *   ③ **种子名本身**就是旧格式（另外 50 条种子**标签是空的**，名字却完整 ——
 *      `[4014][碧蓝之海][3][06][34][极影字幕社]`，照样能认出作品与组）
 */
export function mikanIdOf(tags, name = '') {
  for (const tag of tagsOf(tags)) {
    const old = legacyCells(tag)
    if (old) return old.mikanId
    const now = tag.match(/^mid:(\d+)$/)
    if (now) return now[1]
  }
  const legacy = legacyCells(name)
  return legacy?.mikanId || ''
}

/**
 * 从标签（或种子名）里取字幕组名
 * 顺序：`sg:组名` → 旧格式最后一格（`[字幕组rssId][字幕组名]`）→ 空串交给调用方兜底
 */
export function subgroupOf(tags, name = '') {
  for (const tag of tagsOf(tags)) {
    const now = tag.match(/^sg:(.+)$/)
    if (now && !isBlank(now[1])) return now[1].trim()
  }
  for (const tag of tagsOf(tags)) {
    const old = legacyCells(tag)
    if (old && !isBlank(old.subgroup)) return old.subgroup.trim()
  }
  const legacy = legacyCells(name)
  return legacy && !isBlank(legacy.subgroup) ? legacy.subgroup.trim() : ''
}

/* ── 集数 ──────────────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0')
const isYear = (n) => Number(n) >= 1900 && Number(n) <= 2099

/** 合集：`[01-12]` / `1-12END` / `01~12` */
const RANGE_RE = [/[[(](\d{1,4})\s*[-~]\s*(\d{1,4})(?:end)?[\])]/i, /(\d{1,4})\s*[-~]\s*(\d{1,4})(?:end)?(?!\d)/i]
/** 单集：S01E04 最优先（自己改名的规范写法），其次是文件名里的其它常见写法 */
const SINGLE_RES = [
  /[Ss]\d{1,2}\s?[Ee]\s?(\d{1,4})(?!\d)/,
  /[[(]\s*(\d{1,4})\s*(?:v\d)?\s*[\])]/,
  /第\s*(\d{1,4})\s*[集话話回]/,
  /(?:^|[^A-Za-z])[Ee][Pp]?\.?\s?(\d{1,4})(?!\d)/,
  /[-–—]\s*(\d{1,4})\s*(?:v\d)?(?:[^\d]|$)/,
  /(\d{1,4})\s*[集话話回]/,
]

/** 集号规范化：`4` → `04`；`1-12` / `1~12` → `01-12` */
function normalizeEpisode(raw) {
  const text = String(raw || '').trim()
  const single = text.match(/^(\d{1,4})$/)
  if (single) return pad(single[1])
  const range = text.match(/^(\d{1,4})\s*[-~]\s*(\d{1,4})$/)
  if (range) return `${pad(range[1])}-${pad(range[2])}`
  return ''
}

/**
 * 旧系统的种子名：`[番剧id][番名][季][集][字幕组rssId][字幕组名]`
 * ---------------------------------------------------------------------------
 * 这是**唯一可靠的集数来源**：里面第 4 格就是集数（`[1][01-12]` 是季 + 集）。
 * 不先认这个格式的话，`[1505]` 这种番剧 id 会被当成"第 1505 集"——
 * 实测「黑暗召唤师在地下恋爱中」就这样显示成了「最新 4114 集」。
 */
function legacyCells(text) {
  const m = String(text || '').match(
    /^(?:soraika:)?\[(\d+)]\[([^\]]*)]\[(\d+)]\[([^\]]+)]\[\d+]\[([^\]]*)]$/,
  )
  return m ? { mikanId: m[1], title: m[2], season: Number(m[3]) || 0, episode: m[4], subgroup: m[5] } : null
}

/**
 * 从文件名（或原始种子名）里取集号
 * @returns {string} `'04'` / `'01-12'` / `''`（认不出）
 */
export function episodeOf(text) {
  const s = String(text || '')
  if (!s) return ''

  const legacy = legacyCells(s)
  if (legacy) return normalizeEpisode(legacy.episode)

  for (const re of RANGE_RE) {
    const hit = s.match(re)
    if (hit && !isYear(hit[1]) && !isYear(hit[2])) return `${pad(hit[1])}-${pad(hit[2])}`
  }
  for (const re of SINGLE_RES) {
    for (const hit of s.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) {
      if (!isYear(hit[1])) return pad(hit[1])
    }
  }
  return ''
}

/**
 * 集号 → 排序值
 * 合集取**区间右端**（`01-12` = 已经下到 12 集），认不出 → 0（排到最后）
 */
export function episodeOrder(episode) {
  const text = String(episode || '')
  const range = text.match(/^\d+-(\d+)$/)
  if (range) return Number(range[1])
  const m = text.match(/^(\d+)/)
  return m ? Number(m[1]) : 0
}

/**
 * 集号 → 覆盖的集数（`'04'` → [4]；`'01-12'` → 1..12；认不出 → []）
 * 上限兜底：长篇合集（`01-1200`）不该把数组撑爆，超出就截断。
 */
export function episodesOf(episode, limit = 2000) {
  const text = String(episode || '').trim()
  if (!text) return []
  const range = text.match(/^(\d+)-(\d+)$/)
  if (range) {
    const from = Number(range[1])
    const to = Number(range[2])
    if (!from || to < from) return []
    const out = []
    for (let n = from; n <= to && out.length < limit; n++) out.push(n)
    return out
  }
  const single = text.match(/^(\d+)$/)
  return single ? [Number(single[1])] : []
}

/**
 * 已下的集号 vs 总集数 → 断号（真缺）+ 尾部（还没下）
 * ---------------------------------------------------------------------------
 * 「缺」只指断号：1..已下最大集 之间漏掉的（下了 01 03 05 → 缺 02 04）。
 * 比最大集还大的都是「后面还没下」（连载中 / 只下了一部分），单独算作 tail，
 * 否则下载了 01-12、库里登记 25 话时会报「缺 13 集」—— 那是误导。
 *
 * 另外三条刻意的规则：
 *   · 总集数未知（剧场版 / BGM 没登记）→ 不判缺集（返回空数组，不是"全缺"）
 *   · 一条集号都解析不出来 → parsed=0，调用方据此不显示「已下 0 / 共 13」
 *     （文件在盘上、只是名字里没有集号，说"全缺"是假警报）
 *   · 累积集号的季度：文件写 S02 的 14~25，而库里这一季登记 13 话 ——
 *     全部集号都大于总集数时按最小值整体平移到 1 起（14~25 → 1~12），
 *     否则会误报「一集都没下」
 * @param {string[]} episodes 已下载条目的集号（`episodeOf` 的产物）
 * @param {number} totalEpisodes 库里登记的总集数
 * @returns {{ have: number, missing: number[], tail: number, parsed: number }}
 *   missing = 断号（真缺）；tail = 比已下最大集更靠后的集数（还没下）
 */
export function missingEpisodesOf(episodes, totalEpisodes) {
  const total = Number(totalEpisodes) || 0
  if (!total) return { have: 0, missing: [], tail: 0, parsed: 0 }

  const numbers = []
  for (const episode of episodes || []) numbers.push(...episodesOf(episode))
  if (!numbers.length) return { have: 0, missing: [], tail: 0, parsed: 0 }

  /** 累积集号 → 平移到 1 起（只在这一季的文件全都超出总集数时才平移，避免误伤单集漏号） */
  const offset = numbers.every((n) => n > total) ? Math.min(...numbers) - 1 : 0

  const have = new Set()
  for (const n of numbers) {
    const value = n - offset
    if (value >= 1 && value <= total) have.add(value)
  }
  // 一集都没对上（集号全在范围外）→ 当作"没解析出来"，不显示「已下 0」
  if (!have.size) return { have: 0, missing: [], tail: 0, parsed: numbers.length }

  const latest = Math.max(...have)
  const missing = []
  for (let n = 1; n <= latest; n++) {
    if (!have.has(n)) missing.push(n)
  }
  return { have: have.size, missing, tail: Math.max(0, total - latest), parsed: numbers.length }
}

/**
 * 任务名（qB 里显示的名字）—— 旧方括号格式
 * ---------------------------------------------------------------------------
 * `[mikanId][番名][季][集][组rssId][组名]`
 * 合集也照样能给（集号是 `04-05` 这种区间）—— 任务名和文件名不是一个东西：
 * 任务名对合集有意义，文件名只对单文件种子有意义。
 */
export function torrentNameOf({ title, mikanId = '', season = 1, episode, subgroup = '', rssId = '' }) {
  const clean = (value) =>
    String(value ?? '')
      .replace(/[\\/:*?"<>|[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const name = clean(title)
  const ep = String(episode || '').trim()
  if (!name || !/^\d{1,4}(-\d{1,4})?$/.test(ep)) return null
  const seasonNum = Math.max(1, Number(season) || 1)
  const [from, to] = ep.split('-')
  const epText = to ? `${from.padStart(2, '0')}-${to.padStart(2, '0')}` : from.padStart(2, '0')
  return `[${clean(mikanId)}][${name}][${seasonNum}][${epText}][${clean(rssId)}][${clean(subgroup)}]`
}

/**
 * 文件名（落盘名）—— `番名 S01E01.ext`
 * 只对**单集 + 有扩展名**成立；合集/多文件种子返回 null（不动里面的文件）。
 */
export function fileNameOf({ title, season = 1, episode, ext = '' }) {
  const clean = (value) => String(value ?? '').replace(/[\\/:*?"<>|[\]]/g, ' ').replace(/\s+/g, ' ').trim()
  const name = clean(title)
  const ep = String(episode || '').trim()
  const suffix = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : ''
  if (!name || !/^\d{1,4}$/.test(ep) || !suffix) return null
  const seasonNum = Math.max(1, Number(season) || 1)
  return `${name} S${String(seasonNum).padStart(2, '0')}E${ep.padStart(2, '0')}${suffix.toLowerCase()}`
}

/**
 * 重命名的目标：任务名 + 文件名（两者**各自独立**，合集只有任务名）
 * @returns {{ fileBase:string, fileName:string, torrentName:string } | null}
 */
export function renameTargetOf({ title, mikanId = '', season = 1, episode, ext = '', subgroup = '', rssId = '' }) {
  const torrentName = torrentNameOf({ title, mikanId, season, episode, subgroup, rssId })
  const fileName = fileNameOf({ title, season, episode, ext })
  if (!torrentName && !fileName) return null
  return {
    fileBase: fileName ? fileName.replace(/\.[a-z0-9]+$/i, '') : '',
    fileName: fileName || '',
    torrentName: torrentName || '',
  }
}

/** 文件名里的扩展名（多文件种子没有扩展名 → 空） */
export function extensionOf(fileName) {
  const m = String(fileName || '').match(/\.([a-z0-9]{2,5})$/i)
  return m ? `.${m[1].toLowerCase()}` : ''
}

/**
 * 归档目录（新下载用这一套，命名规范见 docs/ARCHITECTURE.md §7 决策 38）
 * ---------------------------------------------------------------------------
 * `{root}/{番名}/Season 01`（旧写法是 `SE01`，批量迁移以后再补）
 * 剧场版 / 认不出集数（season=0）：不建季目录，直接落在 `{番名}` 下
 * @param {{ title: string, season?: number, root?: string }} params
 */
export function archiveDirOf({ title, season = 1, root = DEFAULT_ROOT }) {
  const safe = String(title || '未命名').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名'
  const base = String(root || DEFAULT_ROOT).replace(/\/+$/, '')
  return season > 0 ? `${base}/${safe}/Season ${pad(season)}` : `${base}/${safe}`
}

/** 加种时写的标签：`soraika`（标记）+ `mid:{Mikan 番剧 id}` + `sg:{字幕组}`；旧写法兼容见 mikanIdOf */
export function buildTags({ mikanId = '', subgroup = '' } = {}) {
  const tags = ['soraika']
  if (mikanId) tags.push(`mid:${mikanId}`)
  if (subgroup) tags.push(`sg:${String(subgroup).replace(/,/g, '，')}`)
  return tags.join(',')
}
